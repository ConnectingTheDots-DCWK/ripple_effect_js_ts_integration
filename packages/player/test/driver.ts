// Plays a conformance fixture through this package's own API and records what
// a reader saw, exactly as the release's FORMAT.md describes — the moves, the
// settle loop, the trace events and what each is read from. What 1.6 added
// (`now`, `permit` and `standIns`, the `countdown`, `expire` and `permit`
// moves, a passage's `timer`, the `permit` and `notice` events) is not in
// FORMAT.md yet, and is written from the engine's own runner,
// `crates/ripple-runtime/src/conformance/`. Two hosts drive it: a `Session`
// directly, and a `Player`, whose holds the caller's `flush` runs to the end
// (fake timers in Node) and whose countdowns are off, as a clock that does
// not wait must have them. Nothing here touches a file, so the
// browser pass plays the same driver in a page. The engine's own suites judge
// its rules; this judges the spelling.
import {
  type Campaign,
  type Effect,
  type Entity,
  isTurn,
  type Moment,
  type PermissionKind,
  Player,
  type RippleValue,
  Session,
  type Turn,
} from '../src/index.ts';

export { canonical } from './canonical.ts';

const STEP_BUDGET = 65_536;

export interface Input {
  locale?: string;
  seed?: bigint;
  needs?: string[];
  /** The instant the fixture was played at, ISO 8601 with its offset. */
  now?: string;
  /** What the host already knows the reader answered, told before `start`. */
  permit?: Partial<Record<PermissionKind, boolean>>;
  /** The reader's stand-ins as typed; a time with no offset is read at UTC. */
  standIns?: Partial<Record<PermissionKind, string>>;
  moves: (
    | { do: 'choose'; choice: bigint }
    | { do: 'answer'; values: Record<string, RippleValue> }
    | { do: 'locale'; locale: string }
    | { do: 'pause' }
    | { do: 'resume' }
    | { do: 'restart' }
    | { do: 'countdown' }
    | { do: 'expire' }
    | { do: 'permit'; kind: PermissionKind; granted: boolean }
  )[];
}

export interface Played {
  readonly trace: unknown[];
  readonly entities: Record<string, Record<string, RippleValue>>;
  /** Every named callback fired, in order: nothing a reader sees, so not in the trace. */
  readonly callbacks: unknown[];
}

/** What drives the story: the same verbs, whichever API is underneath. */
interface Host {
  readonly turn: Turn | undefined;
  start(): void;
  choose(index?: number): void;
  answer(values?: Record<string, RippleValue>): void;
  elapsed(): void;
  setLocale(locale: string): void;
  pause(): string | undefined;
  resume(save: string): void;
  restart(): void;
  beginCountdown(): void;
  expire(): void;
  permit(kind: PermissionKind, granted: boolean): void;
  /** What a host knows before a session starts: the time, the answers, the stand-ins. */
  tell(answered: ReadonlyMap<PermissionKind, boolean>): void;
  entities(): Entity[];
}

export function play(
  campaign: Campaign,
  fixture: Input,
  through: 'session' | 'player',
  flush: () => void = () => {},
): Played {
  const trace: unknown[] = [];
  const callbacks: unknown[] = [];
  const boards = campaign.manifest.boards.map((board) => board.id);
  const record = (effect: Effect) => {
    if (effect.kind === 'callback') callbacks.push(callbackRecord(effect.event, boards));
    const event = traceEvent(effect, boards, campaign);
    if (event) trace.push(event);
  };
  const begin = {
    seed: fixture.seed ?? 0n,
    stepBudget: STEP_BUDGET,
    ...(fixture.locale === undefined ? {} : { locale: fixture.locale }),
  };
  const known = {
    now: fixture.now === undefined ? undefined : moment(fixture.now),
    standIns: Object.entries(fixture.standIns ?? {}) as [PermissionKind, string][],
  };
  const host =
    through === 'session'
      ? sessionHost(campaign, Session.create(campaign, begin), begin.seed, known, record)
      : playerHost(campaign, Session.create(campaign, begin), begin.seed, known, record, flush);

  // What the host remembers the reader answered: the fixture's, and every
  // answer a move gives, told again to a resumed session — a save carries
  // no yes.
  const answered = new Map(Object.entries(fixture.permit ?? {}) as [PermissionKind, boolean][]);
  host.tell(answered);
  let saved: string | undefined;
  host.start();
  for (const [number, move] of fixture.moves.entries()) {
    if (over(host.turn) && saved === undefined) break;
    switch (move.do) {
      case 'choose': {
        const turn = host.turn;
        if (turn?.kind !== 'show')
          throw new Error(`move ${number} chooses, and the story is at ${turn?.kind}`);
        const index = Number(move.choice);
        if (index >= turn.passage.choices.length) {
          throw new Error(`move ${number} takes choice ${index} of ${turn.passage.choices.length}`);
        }
        host.choose(index);
        break;
      }
      case 'answer':
        if (host.turn?.kind !== 'ask')
          throw new Error(`move ${number} answers, and the story is at ${host.turn?.kind}`);
        host.answer(move.values);
        break;
      case 'locale':
        host.setLocale(move.locale);
        break;
      case 'pause': {
        const save = host.pause();
        if (save === undefined)
          throw new Error(`move ${number} pauses where the story is not waiting`);
        saved = save;
        break;
      }
      case 'resume':
        if (saved === undefined) throw new Error(`move ${number} resumes without having paused`);
        host.resume(saved);
        host.tell(answered);
        host.start();
        saved = undefined;
        break;
      case 'restart':
        host.restart();
        break;
      // A fixture's clock never runs a countdown out by itself: the moves say when.
      case 'countdown':
      case 'expire':
        if (host.turn?.kind !== 'show')
          throw new Error(
            `move ${number} runs a countdown, and the story is at ${host.turn?.kind}`,
          );
        if (move.do === 'countdown') host.beginCountdown();
        else host.expire();
        break;
      case 'permit':
        answered.delete(move.kind);
        answered.set(move.kind, move.granted);
        host.permit(move.kind, move.granted);
        break;
    }
  }
  // The reader has left: the story goes on by itself until it is over.
  for (;;) {
    const turn = host.turn;
    // A story nobody gave an answer to never begins, and stops there.
    if (turn === undefined || over(turn) || turn.kind === 'permit') break;
    if (turn.kind === 'show') host.choose();
    else if (turn.kind === 'ask') host.answer();
    else host.elapsed();
  }
  const entities: Record<string, Record<string, RippleValue>> = {};
  for (const entity of host.entities()) {
    entities[entity.key] = entity.values instanceof Map ? Object.fromEntries(entity.values) : {};
  }
  return { trace, entities, callbacks };
}

// The engine's reading of a fixture's `now`: ISO 8601 with an offset, or
// none, which is UTC.
function moment(text: string): Moment {
  const utcMs = Date.parse(/(?:Z|[+-]\d\d:?\d\d)$/.test(text) ? text : `${text}Z`);
  if (Number.isNaN(utcMs)) throw new Error(`now is not a time: ${text}`);
  const offset = /([+-])(\d\d):?(\d\d)$/.exec(text);
  const minutes = offset ? Number(offset[2]) * 60 + Number(offset[3]) : 0;
  return { utcMs, offsetMinutes: offset?.[1] === '-' ? -minutes : minutes };
}

// FORMAT.md's record: the board by id, an index as an Int, and a null value
// written as nothing, as the engine's own runner writes it.
function callbackRecord(
  fired: Extract<Effect, { kind: 'callback' }>['event'],
  boards: string[],
): unknown {
  return {
    callback: fired.callback,
    event: fired.event,
    ...(fired.board === undefined ? {} : { board: boards[fired.board] ?? '' }),
    ...(fired.node === undefined ? {} : { node: fired.node }),
    ...(fired.name === undefined ? {} : { name: fired.name }),
    ...(fired.from === undefined || fired.from === null ? {} : { from: fired.from }),
    ...(fired.to === undefined || fired.to === null ? {} : { to: fired.to }),
    ...(fired.index === undefined ? {} : { index: BigInt(fired.index) }),
  };
}

function over(turn: Turn | undefined): boolean {
  return (
    turn === undefined || turn.kind === 'ended' || turn.kind === 'failed' || turn.kind === 'stopped'
  );
}

function traceEvent(effect: Effect, boards: string[], campaign: Campaign): unknown {
  switch (effect.kind) {
    case 'show':
      return {
        kind: 'passage',
        node: effect.passage.node,
        markdown: effect.passage.text,
        choices: effect.passage.choices.map((choice) => choice.text),
        ...(effect.passage.untranslated === undefined
          ? {}
          : { untranslated: effect.passage.untranslated }),
        ...(effect.passage.timer === undefined
          ? {}
          : {
              timer: {
                after: BigInt(effect.passage.timer.afterMs),
                timeout: BigInt(effect.passage.timer.timeoutMs),
                visible: effect.passage.timer.visible,
                default: BigInt(effect.passage.timer.default),
              },
            }),
      };
    case 'ask':
      return {
        kind: 'prompt',
        node: effect.prompt.node,
        // `optional` written only when true, `options` only when there are
        // any, so a fixture from before either reads as it was.
        fields: effect.prompt.fields.map((field) => ({
          name: field.name,
          type: field.type,
          ...(field.optional ? { optional: true } : {}),
          ...(field.options.length === 0
            ? {}
            : { options: field.options.map((option) => option.id) }),
        })),
      };
    case 'permit':
      return { kind: 'permit', kinds: [...effect.kinds] };
    // `of`, because `kind` is the event's own.
    case 'notice':
      return {
        kind: 'notice',
        code: effect.notice.code,
        of: effect.notice.kind,
        ...(effect.notice.node === undefined ? {} : { node: effect.notice.node }),
        message: effect.notice.message,
      };
    case 'jumped':
      return {
        kind: 'jump',
        board: boards[effect.board] ?? '',
        ...(effect.node === undefined ? {} : { node: effect.node }),
      };
    case 'ended':
      return effect.ranOut
        ? { kind: 'ranOut' }
        : { kind: 'end', ...(effect.title === undefined ? {} : { title: effect.title }) };
    case 'failed':
      return {
        kind: 'error',
        message: effect.message,
        ...(effect.node === undefined ? {} : { node: effect.node }),
      };
    case 'hold':
      return { kind: 'wait', ms: BigInt(effect.ms) };
    case 'ambience':
      return { kind: 'ambience', soundscape: effect.ambience?.soundscape.id ?? null };
    case 'audio':
      if (effect.command.kind !== 'cue') return undefined;
      return {
        kind: 'sound',
        ...(effect.command.node === undefined ? {} : { node: effect.command.node }),
        media: campaign.mediaPath(effect.command.media) ?? '',
      };
    default:
      return undefined;
  }
}

function lastTurn(effects: readonly Effect[], current: Turn | undefined): Turn | undefined {
  let turn = current;
  for (const effect of effects) {
    if (isTurn(effect)) turn = effect;
  }
  return turn;
}

/** What the fixture's host knows before any session starts. */
interface Known {
  readonly now: Moment | undefined;
  readonly standIns: readonly [PermissionKind, string][];
}

function sessionHost(
  campaign: Campaign,
  first: Session,
  seed: bigint,
  known: Known,
  record: (effect: Effect) => void,
): Host {
  let session = first;
  let turn: Turn | undefined;
  // Records a batch, and while it ends in a hold says `elapsed`: a fixture's
  // clock never waits.
  const settle = (effects: Effect[]) => {
    let batch = effects;
    for (;;) {
      batch.forEach(record);
      turn = lastTurn(batch, turn);
      if (batch.at(-1)?.kind !== 'hold') return;
      batch = session.elapsed();
    }
  };
  return {
    get turn() {
      return turn;
    },
    start: () => settle(session.start()),
    choose: (index) => settle(session.choose(index)),
    answer: (values) => settle(session.answer(values)),
    elapsed: () => settle(session.elapsed()),
    setLocale: (locale) => settle(session.setLocale(locale)),
    pause: () => {
      const paused = session.pause();
      settle(paused.effects);
      return paused.save;
    },
    resume: (save) => {
      const generator = session.generator;
      session = Session.resume(campaign, save, { seed, stepBudget: STEP_BUDGET });
      session.generator = generator;
    },
    restart: () => settle(session.restart()),
    beginCountdown: () => settle(session.beginCountdown()),
    expire: () => settle(session.expire()),
    permit: (kind, granted) => settle(session.permit(kind, granted)),
    tell: (answered) => {
      if (known.now !== undefined) session.setNow(known.now);
      // Before `start`, so an answer answers nothing.
      for (const [kind, granted] of answered) session.permit(kind, granted);
      for (const [kind, typed] of known.standIns) session.setStandIn(kind, typed, 0);
    },
    entities: () => session.entities,
  };
}

function playerHost(
  campaign: Campaign,
  first: Session,
  seed: bigint,
  known: Known,
  record: (effect: Effect) => void,
  flush: () => void,
): Host {
  // The fixture's instant, which the player stamps every verb with once
  // `dateTime` is allowed; and no countdown run by the clock.
  const handlers = { onEffect: record, now: () => known.now, countdowns: false };
  let player = new Player(first, handlers);
  // Every hold the player is waiting on, run to the end: the fixture's clock.
  const run = (verb: () => void) => {
    verb();
    flush();
  };
  return {
    get turn() {
      return player.turn;
    },
    start: () => run(() => player.start()),
    choose: (index) => run(() => player.choose(index)),
    answer: (values) => run(() => player.answer(values)),
    elapsed: () => run(() => player.session.elapsed().forEach(record)),
    setLocale: (locale) => run(() => player.setLocale(locale)),
    pause: () => {
      const save = player.pause();
      flush();
      return save;
    },
    resume: (save) => {
      const generator = player.session.generator;
      player.dispose();
      const session = Session.resume(campaign, save, { seed, stepBudget: STEP_BUDGET });
      session.generator = generator;
      player = new Player(session, handlers);
    },
    restart: () => run(() => player.restart()),
    beginCountdown: () => run(() => player.beginCountdown()),
    expire: () => run(() => player.expire()),
    permit: (kind, granted) => run(() => player.permit(kind, granted)),
    tell: (answered) => {
      for (const [kind, granted] of answered) player.permit(kind, granted);
      for (const [kind, typed] of known.standIns) player.setStandIn(kind, typed, 0);
    },
    entities: () => player.session.entities,
  };
}
