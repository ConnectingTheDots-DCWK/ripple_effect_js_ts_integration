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
  toAmbienceOrNull,
  toCvar,
  toEffects,
  toEntity,
  toMemory,
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
  readonly stepBudget?: number;
  readonly silentJumpLimit?: number;
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
  /** What the dice are seeded with. The one setting a host should always choose. */
  readonly seed?: number | bigint;
  /** The digest a save was made against, when starting where one left off. */
  readonly digest?: string;
}

export interface ResumeStart extends SessionOptions {
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

  start(): Effect[] {
    return this.#verb((raw) => raw.start());
  }

  /** Takes the choice at `index` among those offered; with none, the story goes on by itself. */
  choose(index?: number): Effect[] {
    return this.#verb((raw) => raw.choose(index));
  }

  /** Answers the prompt showing. Values go to the engine exactly as given. */
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

  /** Reads on in another language; the passage showing is shown again in it. */
  setLocale(locale: string): Effect[] {
    return this.#verb((raw) => raw.setLocale(locale));
  }

  /** Starts over, forgetting every entity and keeping the language. */
  restart(): Effect[] {
    return this.#verb((raw) => raw.restart());
  }

  /** Puts the story down, answering a save to resume from. */
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

  /** A save of where the story is, without putting it down. */
  checkpoint(): string | undefined {
    return this.#call((raw) => raw.checkpoint());
  }

  /**
   * Writes a console variable. `refused` carries the engine's sentence when
   * the value does not fit the type; `unknown` when there is no such variable.
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
