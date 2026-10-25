// The session: the host API's verbs, one to one with the engine's.
//
// Every verb answers the ordered effects it led to, and the last of them says
// where the story now is (`campaign-host-api.md` §4a). Calls are synchronous
// and run on the caller's thread; one queue, in call order, is the host's to
// keep, and nothing here makes a promise (ADR *a-campaign-plays-in-a-page*,
// decision 4). `Player` is the loop over this, for a host that would rather
// not write one.

import type { BundleFailure as BundleFailureRaw } from '../generated/no-python/interfaces/ripple-engine-bundle.js';
import type * as python from '../generated/no-python/interfaces/ripple-engine-python.js';
import type * as wit from '../generated/no-python/interfaces/ripple-engine-session.js';
import type { Campaign } from './campaign.js';
import {
  type Ambience,
  type CvarSnapshot,
  type Effect,
  type Entity,
  type Memory,
  type PermissionKind,
  toAmbienceOrNull,
  toCvar,
  toEffects,
  toEntity,
  toMemory,
  toWitPermission,
} from './effects.js';
import {
  BundleError,
  bundleFailure,
  HostError,
  hostFailure,
  ResumeError,
  resumeFailure,
} from './errors.js';
import { fromArena, type RippleValue, toArena } from './values.js';

/** How long a script may run, how much it may hold, how deep it may recurse. */
export interface ScriptLimits {
  readonly deadlineMs: number;
  readonly memoryBytes: number;
  readonly recursionDepth: number;
}

/** The engine's budgets and policies; each defaults to the engine's own. */
export interface SessionOptions {
  /**
   * How many node turns one board may take before the run is called a
   * runaway and the story fails, rather than hang the page. The engine's is
   * 1 048 576.
   */
  readonly stepBudget?: number;
  /**
   * How many boards may hand over in a row without a word of story before
   * the story fails. The engine's is 64; zero fails the first such jump.
   */
  readonly silentJumpLimit?: number;
  /**
   * How often one loop node may go round in one board run before the story
   * fails. The engine's is 512; **zero is no ceiling**.
   */
  readonly loopLimit?: number;
  readonly scriptLimits?: ScriptLimits;
  /**
   * A passage with no text in the language being read: `report` shows it
   * empty and names the language, `fall-back` shows the default language's
   * text and still names it.
   */
  readonly untranslated?: 'report' | 'fall-back';
  /** Collect the run trace in every batch — off unless a host shows it. */
  readonly trace?: boolean;
  readonly tracePayloads?: boolean;
}

export interface SessionStart extends SessionOptions {
  /** The board to begin on, by index; the campaign's first entry otherwise. */
  readonly board?: number;
  readonly entryNode?: string;
  /** The language to begin in; the one the story was written in otherwise. */
  readonly locale?: string;
  /**
   * What the dice are seeded with. The one setting a host should always
   * choose: left out it is zero, and every reader rolls the same dice.
   */
  readonly seed?: number | bigint;
  /**
   * A label stamped on every save this session writes — a hash of the
   * bundle, say, so a host can tell its own saves apart. The engine carries
   * it and never compares it (`campaign-host-api.md` §8).
   */
  readonly digest?: string;
}

export interface ResumeStart extends SessionOptions {
  /** As `SessionStart.seed`: zero when left out. */
  readonly seed?: number | bigint;
}

/** What `pause` answers: the save, when the story was somewhere to come back to. */
export interface Paused {
  readonly save?: string;
  readonly effects: Effect[];
}

/** The answer to a prompt, by field name. */
export type Answers =
  | ReadonlyMap<string, RippleValue>
  | Readonly<Record<string, RippleValue | Readonly<Record<string, RippleValue>>>>;

/**
 * What the script guard has given up on this playthrough (`campaign-runtime.md`
 * §8.4): the scripts stopped at the deadline, the runs refused, and whether
 * no script will be started again.
 */
export interface GuardReport {
  /** The names the stopped scripts ran under, sorted, repeats kept. */
  readonly abandoned: readonly string[];
  /** How many runs were never started. */
  readonly refused: number;
  readonly exhausted: boolean;
}

/** Why a script stopped. */
export interface PythonFailure {
  /**
   * The Python exception's class — `NameError`, `SyntaxError` — or one of
   * the engine's labels: `timeout`, `refused`, `closed`, `host-error`,
   * `unavailable` (an engine without Python).
   */
  readonly type: string;
  readonly message: string;
  readonly line?: number;
  readonly traceback?: string;
}

/** What a line of Python answered. */
export interface PythonResult {
  /** The last expression's value, or `null`. */
  readonly value: RippleValue;
  /** Everything it printed. */
  readonly output: string;
  readonly error?: PythonFailure;
}

/**
 * An instant, as a host hands it to a story: milliseconds since the epoch,
 * and the offset in minutes the reader's wall clock is at — east positive,
 * so Rome in October is `120`. `momentOf` makes one from a `Date`.
 */
export interface Moment {
  readonly utcMs: number;
  readonly offsetMinutes: number;
}

/**
 * What `date` is, with this machine's offset at that instant — the reader's
 * clock, for a host to hand `setNow`. Now, when no date is given.
 */
export function momentOf(date: Date = new Date()): Moment {
  // getTimezoneOffset is west positive, the opposite of every offset written.
  return { utcMs: date.getTime(), offsetMinutes: -date.getTimezoneOffset() || 0 };
}

/**
 * A position fix, shaped after the web's `GeolocationPosition`; any part of
 * it may be absent. A place's name with no coordinates is a fix too.
 */
export interface Position {
  readonly label?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  /** In metres. */
  readonly accuracy?: number;
  /** When it was taken. */
  readonly when?: Moment;
}

/**
 * The offset this machine's clock is at on the date a reader typed — what a
 * stand-in written without one is read at. The offset now, for text that
 * names no date.
 */
export function localOffsetFor(typed: string): number {
  // A date and a time with no offset is local time to `Date`; a date alone
  // is UTC midnight, which is the same day everywhere but the date line.
  const date = new Date(typed.trim().replace(' ', 'T'));
  return momentOf(Number.isNaN(date.getTime()) ? new Date() : date).offsetMinutes;
}

const DEFAULTS = { stepBudget: 1 << 20, silentJumpLimit: 64, loopLimit: 512 } as const;

export class Session {
  readonly #raw: wit.Session;

  private constructor(
    readonly campaign: Campaign,
    raw: wit.Session,
  ) {
    this.#raw = raw;
  }

  static create(campaign: Campaign, start: SessionStart = {}): Session {
    const config: wit.SessionConfig = {
      board: start.board ?? campaign.manifest.entries[0] ?? 0,
      seed: BigInt(start.seed ?? 0),
      options: options(campaign, start),
      ...(start.entryNode === undefined ? {} : { entryNode: start.entryNode }),
      ...(start.locale === undefined ? {} : { locale: start.locale }),
      ...(start.digest === undefined ? {} : { digest: start.digest }),
    };
    const raw = campaign.engine.call(
      (root) => root.session.Session.create(campaign.handle, config),
      (failure: BundleFailureRaw) => new BundleError(bundleFailure(failure)),
    );
    return new Session(campaign, raw);
  }

  /** A session picking up `save`, which `pause` or `checkpoint` wrote. */
  static resume(campaign: Campaign, save: string, start: ResumeStart = {}): Session {
    const raw = campaign.engine.call(
      (root) =>
        root.session.Session.resuming(
          campaign.handle,
          save,
          BigInt(start.seed ?? 0),
          options(campaign, start),
        ),
      (failure: wit.ResumeFailure) => new ResumeError(resumeFailure(failure)),
    );
    return new Session(campaign, raw);
  }

  /**
   * Begins the story. While a kind the campaign reads (`manifest.permissions`)
   * has no answer, the answer is one `permit` effect and nothing else: no
   * page, no callback, until `permit` has answered them all.
   */
  start(): Effect[] {
    return this.#verb((raw) => raw.start());
  }

  /**
   * Takes the choice at `index` among those offered. With none, the reader
   * leaves: the passage flows nowhere and the story ends there
   * (`campaign-host-api.md` §4, rule 2).
   */
  choose(index?: number): Effect[] {
    return this.#verb((raw) => raw.choose(index));
  }

  /**
   * Answers the prompt showing. Values go to the engine exactly as given,
   * keyed by each field's `name`. An optional field left empty is left out
   * or `null`; a required one is not submitted empty, which is the host's
   * rule to keep. A field with `options` is answered with the picked ids: a
   * string, or a list of them for a `…List`. With none, the reader leaves,
   * as with `choose()`.
   */
  answer(values?: Answers): Effect[] {
    const fields =
      values === undefined
        ? undefined
        : (values instanceof Map ? [...values] : Object.entries(values)).map(([key, value]) => ({
            key,
            value: toArena(value as RippleValue),
          }));
    return this.#verb((raw) => raw.answer(fields));
  }

  /** Says the wait a `hold` asked for is over. */
  elapsed(): Effect[] {
    return this.#verb((raw) => raw.elapsed());
  }

  /**
   * Says the showing passage's countdown begins: its `timer.afterMs` has
   * passed on the host's clock. Nothing moves; the answer is only the
   * `countdown.started` callback, if an author declared one. A second call
   * answers nothing. A passage with no timer is a `no-countdown` refusal.
   */
  beginCountdown(): Effect[] {
    return this.#verb((raw) => raw.beginCountdown());
  }

  /**
   * Says the countdown ran out: the passage's default is taken, as
   * `choose(timer.default)` would, after a `countdown.expired` callback.
   * Before `beginCountdown` it is a `countdown-not-begun` refusal — the
   * second timer of two fired without the first.
   */
  expire(): Effect[] {
    return this.#verb((raw) => raw.expire());
  }

  /**
   * The reader's answer about one kind, at any time — before `start` too,
   * for a host that already knows it, and then nobody is asked. On a
   * `permit` turn, the answer to the last kind unanswered begins the story,
   * and this answers everything up to its first real turn. Not part of a
   * save: a resumed session is answered again.
   */
  permit(kind: PermissionKind, granted: boolean): Effect[] {
    return this.#verb((raw) => raw.permit(toWitPermission(kind), granted));
  }

  /**
   * What time it is, before every verb that can step, from a host the reader
   * allowed `dateTime`; `undefined` is no clock. Within one verb time does
   * not move. `momentOf()` is now.
   */
  setNow(now?: Moment): void {
    this.#call((raw) =>
      raw.setNow(
        now === undefined
          ? undefined
          : { utcMs: BigInt(Math.trunc(now.utcMs)), offsetMinutes: now.offsetMinutes },
      ),
    );
  }

  /**
   * The host's last position fix, or `undefined` for none. Refused as
   * `not-permitted` once the reader has said no to `location`; one given
   * before the answer is kept and read only if it is yes, so a host that
   * fetches a fix on a yes hands it over before the `permit` that says so.
   */
  setPosition(fix?: Position): void {
    this.#call((raw) => raw.setPosition(fix === undefined ? undefined : witPosition(fix)));
  }

  /**
   * What the reader would rather a story believed, as they typed it — an
   * ISO 8601 time for `dateTime`, `"lat, lon"` or a place's name for
   * `location` — answered whenever the real value is missing. `undefined`
   * takes it away. A time typed without an offset is read at
   * `localOffsetMinutes`, this machine's own on that date unless given. One
   * that does not read is a `stand-in` refusal, and the one before stays.
   */
  setStandIn(kind: PermissionKind, typed?: string, localOffsetMinutes?: number): void {
    const offset = localOffsetMinutes ?? (typed === undefined ? 0 : localOffsetFor(typed));
    this.#call((raw) => raw.setStandIn(toWitPermission(kind), typed, offset));
  }

  /**
   * Reads on in another language. The passage or the prompt showing is
   * shown again in it — a prompt's labels, placeholders and options
   * reworded, its field names and option ids kept — and a countdown keeps
   * running: it is the same visit.
   */
  setLocale(locale: string): Effect[] {
    return this.#verb((raw) => raw.setLocale(locale));
  }

  /** Starts over, forgetting every entity and keeping the language. */
  restart(): Effect[] {
    return this.#verb((raw) => raw.restart());
  }

  /**
   * Puts the story down and ends this session, answering a save to pick up
   * with `Session.resume` — when the story is on a passage or a prompt.
   * Anywhere else nothing stops, and there is no save and no effect. Not
   * `SoundscapeDriver.pause`, which only holds the sound.
   */
  pause(): Paused {
    const paused = this.#call((raw) => raw.pause());
    return {
      effects: toEffects(paused.effects, this.campaign),
      ...(paused.save === undefined ? {} : { save: paused.save }),
    };
  }

  /** Ends the session for good. */
  stop(): Effect[] {
    return this.#verb((raw) => raw.stop());
  }

  /**
   * A save of where the story is, without putting it down — absent unless
   * the story is on a passage or a prompt.
   */
  checkpoint(): string | undefined {
    return this.#call((raw) => raw.checkpoint());
  }

  /**
   * Writes a console variable. `refused` carries the engine's sentence when
   * the value does not fit the type — English, for showing and never for
   * parsing; `unknown` when there is no such variable. The effects are the
   * host's to deliver: a `Player` never sees them.
   */
  writeCvar(
    name: string,
    value: RippleValue,
  ): { outcome: 'done' | 'unknown' | { refused: string }; effects: Effect[] } {
    const change = this.#call((raw) => raw.writeCvar(name, toArena(value)));
    return {
      outcome: cvarOutcome(change.outcome),
      effects: toEffects(change.effects, this.campaign),
    };
  }

  resetCvar(name: string): {
    outcome: 'done' | 'unknown' | { refused: string };
    effects: Effect[];
  } {
    const change = this.#call((raw) => raw.resetCvar(name));
    return {
      outcome: cvarOutcome(change.outcome),
      effects: toEffects(change.effects, this.campaign),
    };
  }

  resetAllCvars(): Effect[] {
    return this.#verb((raw) => raw.resetAllCvars());
  }

  removeEntity(key: string): { removed: boolean; effects: Effect[] } {
    const removal = this.#call((raw) => raw.removeEntity(key));
    return { removed: removal.removed, effects: toEffects(removal.effects, this.campaign) };
  }

  /** The index of the board the story is on. */
  get board(): number {
    return this.#call((raw) => raw.board());
  }

  get locale(): string {
    return this.#call((raw) => raw.locale());
  }

  get defaultLocale(): string {
    return this.#call((raw) => raw.defaultLocale());
  }

  /** The soundscape in force, or `null` for silence. */
  get ambience(): Ambience | null {
    return this.#call((raw) => toAmbienceOrNull(raw.ambience()));
  }

  get entities(): Entity[] {
    return this.#call((raw) => raw.entities().map(toEntity));
  }

  get memory(): Memory {
    return this.#call((raw) => toMemory(raw.memory()));
  }

  get cvars(): CvarSnapshot[] {
    return this.#call((raw) => raw.cvars().map(toCvar));
  }

  /** What the script guard has given up on so far. */
  get guard(): GuardReport {
    return this.#call((raw) => {
      const report = raw.guard();
      return {
        abandoned: report.abandoned,
        refused: report.refused,
        exhausted: report.exhausted,
      };
    });
  }

  /**
   * One line of Python against the live story: its entities, its variables,
   * its sounds. What it led to comes back with the answer, to be delivered
   * like any verb's effects. Without Python the answer is an `unavailable`
   * failure, not an exception.
   */
  consoleFeed(code: string): { result: PythonResult; effects: Effect[] } {
    const fed = this.#call((raw) => raw.consoleFeed(code));
    return { result: toPythonResult(fed.result), effects: toEffects(fed.effects, this.campaign) };
  }

  /** Whether this session's engine can run the campaign's scripts. */
  get pythonAvailable(): boolean {
    return this.#call((raw) => raw.pythonAvailable());
  }

  /** Why writing `value` to `name` would be refused, or `undefined` if it would not. */
  describeCvarWrite(name: string, value: RippleValue): string | undefined {
    return this.#call((raw) => raw.describeCvarWrite(name, toArena(value)));
  }

  setTrace(enabled: boolean): void {
    this.#call((raw) => raw.setTrace(enabled));
  }

  setTracePayloads(enabled: boolean): void {
    this.#call((raw) => raw.setTracePayloads(enabled));
  }

  /**
   * The dice's state. A save carries none, so a host that wants a resumed
   * story to roll on where it was hands this to the resumed session.
   */
  get generator(): { readonly lo: number; readonly hi: number } {
    return this.#call((raw) => raw.generator());
  }

  set generator(state: { readonly lo: number; readonly hi: number }) {
    this.#call((raw) => raw.setGenerator({ lo: state.lo, hi: state.hi }));
  }

  #verb(body: (raw: wit.Session) => wit.Effect[]): Effect[] {
    return toEffects(this.#call(body), this.campaign);
  }

  #call<T>(body: (raw: wit.Session) => T): T {
    return this.campaign.engine.call(
      () => body(this.#raw),
      (failure: wit.HostFailure) => new HostError(hostFailure(failure)),
    );
  }
}

function options(campaign: Campaign, given: SessionOptions): wit.SessionOptions {
  const limits = given.scriptLimits;
  return {
    stepBudget: given.stepBudget ?? DEFAULTS.stepBudget,
    silentJumpLimit: given.silentJumpLimit ?? DEFAULTS.silentJumpLimit,
    loopLimit: given.loopLimit ?? DEFAULTS.loopLimit,
    scriptLimits: limits
      ? {
          deadlineMs: BigInt(limits.deadlineMs),
          memoryBytes: BigInt(limits.memoryBytes),
          recursionDepth: limits.recursionDepth,
        }
      : campaign.engine.call((root) => root.python.defaultScriptLimits()),
    untranslated: given.untranslated ?? 'report',
    trace: given.trace ?? false,
    tracePayloads: given.tracePayloads ?? false,
  };
}

function witPosition(fix: Position): wit.Position {
  return {
    ...(fix.label === undefined ? {} : { label: fix.label }),
    ...(fix.latitude === undefined ? {} : { latitude: fix.latitude }),
    ...(fix.longitude === undefined ? {} : { longitude: fix.longitude }),
    ...(fix.accuracy === undefined ? {} : { accuracy: fix.accuracy }),
    ...(fix.when === undefined
      ? {}
      : {
          when: {
            utcMs: BigInt(Math.trunc(fix.when.utcMs)),
            offsetMinutes: fix.when.offsetMinutes,
          },
        }),
  };
}

function toPythonResult(raw: python.PythonResult): PythonResult {
  const error = raw.error;
  return {
    value: fromArena(raw.value),
    output: raw.output,
    ...(error === undefined
      ? {}
      : {
          error: {
            type: error.kind.tag === 'python' ? error.kind.val : error.kind.tag,
            message: error.message,
            ...(error.line === undefined ? {} : { line: error.line }),
            ...(error.traceback === undefined ? {} : { traceback: error.traceback }),
          },
        }),
  };
}

function cvarOutcome(raw: wit.CvarWrite): 'done' | 'unknown' | { refused: string } {
  return raw.tag === 'refused' ? { refused: raw.val } : raw.tag;
}
