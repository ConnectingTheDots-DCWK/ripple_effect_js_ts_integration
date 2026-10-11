// Plays a conformance fixture through this package's own API and records what
// a reader saw, exactly as the release's FORMAT.md describes — the moves, the
// settle loop, the trace events and what each is read from. Two hosts drive
// it: a `Session` directly, and a `Player`, whose holds the caller's `flush`
// runs to the end (fake timers in Node). Nothing here touches a file, so the
// browser pass plays the same driver in a page. The engine's own suites judge
// its rules; this judges the spelling.
import {
  type Campaign,
  type Effect,
  type Entity,
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
  moves: (
    | { do: 'choose'; choice: bigint }
    | { do: 'answer'; values: Record<string, RippleValue> }
    | { do: 'locale'; locale: string }
    | { do: 'pause' }
    | { do: 'resume' }
    | { do: 'restart' }
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
  const host =
    through === 'session'
      ? sessionHost(campaign, Session.create(campaign, begin), begin.seed, record)
      : playerHost(campaign, Session.create(campaign, begin), begin.seed, record, flush);

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
        saved = undefined;
        break;
      case 'restart':
        host.restart();
        break;
    }
  }
  // The reader has left: the story goes on by itself until it is over.
  for (;;) {
    const turn = host.turn;
    if (turn === undefined || over(turn)) break;
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
      };
    case 'ask':
      return {
        kind: 'prompt',
        node: effect.prompt.node,
        fields: effect.prompt.fields.map((field) => ({ name: field.name, type: field.type })),
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
    if (['show', 'ask', 'hold', 'ended', 'failed', 'stopped'].includes(effect.kind))
      turn = effect as Turn;
  }
  return turn;
}

function sessionHost(
  campaign: Campaign,
  first: Session,
  seed: bigint,
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
      settle(session.start());
    },
    restart: () => settle(session.restart()),
    entities: () => session.entities,
  };
}

function playerHost(
  campaign: Campaign,
  first: Session,
  seed: bigint,
  record: (effect: Effect) => void,
  flush: () => void,
): Host {
  const handlers = { onEffect: record };
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
      run(() => player.start());
    },
    restart: () => run(() => player.restart()),
    entities: () => player.session.entities,
  };
}
