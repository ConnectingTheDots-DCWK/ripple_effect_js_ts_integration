// The loop over a session, written once: the safe way to play a campaign.
//
// A `Player` hands every effect to the host's listener in order, keeps the
// turn the last one named, and is the host's clock for a `hold` — it waits
// the milliseconds the story asked for and says `elapsed` (§14 of the host
// API asks a host to route a hold to its own clock, and this is that). A
// verb while a hold is pending cancels the wait first, so a restart during a
// pause in the story does not wake the story up again a moment later.
//
// It is the host's clock for a passage's countdown the same way
// (`campaign-host-api.md` §4b): it waits the timer's `afterMs`, says
// `beginCountdown`, waits its `timeoutMs` and says `expire`, and drops both
// waits the moment the story moves. And it is the clock a story reads: once
// the reader has allowed `dateTime` through `permit`, every verb it makes is
// stamped with the host's instant first (§7a), so within one verb time does
// not move.
//
// It is also the host-side table the author's named callbacks are dispatched
// through (`campaign-host-api.md` §5b): a handler registered under a name is
// called where the engine placed the callback in its batch, a name nobody
// registered is counted and nothing more, and a handler that throws is
// reported and the batch goes on — the host's to absorb, because the verb is
// still delivering the rest of what it led to.
import type { CallbackEvent, ChoiceTimer, Effect, PermissionKind, Turn } from './effects.js';
import { RippleError } from './errors.js';
import {
  type Answers,
  type Moment,
  momentOf,
  type Position,
  type PythonResult,
  type Session,
} from './session.js';
import type { SoundscapeDriver } from './soundscape.js';

export interface PlayerHandlers {
  /** Every effect, in the order the engine produced it. */
  readonly onEffect: (effect: Effect) => void;
  /**
   * An error from a verb the player made by itself — the `elapsed` after a
   * hold, a countdown's `beginCountdown` and `expire` — or thrown by a handler while a batch was being delivered: by
   * `onEffect`, a callback handler or the sound. The batch goes on either
   * way. **Without this, a failure after a hold is an uncaught exception**,
   * thrown from a timer where nothing of the host's can catch it; a
   * handler's error goes to the page's own error reporting. A verb the host
   * calls throws to the host instead.
   */
  readonly onError?: (error: unknown) => void;
  /**
   * Where the story's sound goes. Every `audio` effect is applied to it as
   * well as handed to `onEffect`; without one, nothing is heard.
   */
  readonly audio?: SoundscapeDriver;
  /**
   * What time it is, for the story: read before every verb once the reader
   * has allowed `dateTime` through `permit`, and never before. The
   * machine's clock, `momentOf()`, unless given; a test passes a fixed
   * instant, and `undefined` is no clock.
   */
  readonly now?: () => Moment | undefined;
  /**
   * Whether the player runs a passage's countdown down by itself. **Off for
   * a host whose clock does not wait** — a test, an agent walking every
   * branch — where a countdown would only ever take the default: such a
   * host calls `beginCountdown` and `expire` where it means them. Off is
   * also how a host honours a reader who asked for no time limits
   * (WCAG 2.2.1). On unless `false`.
   */
  readonly countdowns?: boolean;
  /**
   * Where the showing passage's countdown stands, for a host to draw:
   * waiting out its `afterMs`, then begun, and `undefined` once there is
   * none, because the reader chose, it ran out or the story moved. A change
   * of language says nothing: it is the same visit and the same countdown.
   */
  readonly onCountdown?: (countdown: Countdown | undefined) => void;
}

/** A countdown the player is running. */
export interface Countdown {
  readonly timer: ChoiceTimer;
  /** False while it waits out `timer.afterMs`; true once it runs, for `timer.timeoutMs`. */
  readonly begun: boolean;
}

/** What a callback handler is given: the event, as the engine fired it. */
export type CallbackHandler = (fired: CallbackEvent) => void;

/**
 * A verb called on a `Player` while it is delivering a batch — from inside
 * `onEffect` or a callback handler. The rest of that batch would arrive
 * after the new one, out of order. Schedule the verb instead, with
 * `queueMicrotask` or `setTimeout`.
 */
export class ReentrantVerb extends RippleError {
  override name = 'ReentrantVerb';
  constructor(verb: string) {
    super(
      `${verb}() was called while the player was delivering a batch; schedule it with queueMicrotask instead`,
    );
  }
}

export class Player {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #countdownTimer: ReturnType<typeof setTimeout> | undefined;
  #countdown: Countdown | undefined;
  #turn: Turn | undefined;
  /** The kinds this player has told the engine yes to; a save carries none. */
  readonly #granted = new Set<PermissionKind>();
  #disposed = false;
  #delivering = false;
  readonly #callbacks = new Map<string, CallbackHandler>();
  readonly #everyCallback = new Set<CallbackHandler>();
  #misses = 0;

  constructor(
    /**
     * The session underneath, for what the player does not wrap: the
     * story's state, `checkpoint`, the console variables and entities.
     * **A verb called on it goes round the player**: a pending hold is not
     * cancelled and may wake a later turn, and nothing it answers reaches
     * `onEffect` or the sound — `writeCvar`'s effects, say, are the host's
     * to deliver.
     */
    readonly session: Session,
    readonly handlers: PlayerHandlers,
  ) {}

  /** Where the story is: the last passage, prompt, question, wait or ending shown. */
  get turn(): Turn | undefined {
    return this.#turn;
  }

  /** Where the showing passage's countdown stands, or `undefined` for none running. */
  get countdown(): Countdown | undefined {
    return this.#countdown;
  }

  /**
   * Calls `handler` whenever the callback the author named `name` fires,
   * replacing any handler already under that name. Answers the function
   * that removes it again.
   *
   * It runs inside the verb that fired it, where the engine placed it: a
   * callback about a passage arrives before the passage does. It must not
   * call a verb on this player; schedule one instead.
   */
  onCallback(name: string, handler: CallbackHandler): () => void {
    this.#callbacks.set(name, handler);
    return () => {
      if (this.#callbacks.get(name) === handler) this.#callbacks.delete(name);
    };
  }

  /** Calls `handler` for every callback that fires, registered or not. */
  onAnyCallback(handler: CallbackHandler): () => void {
    this.#everyCallback.add(handler);
    return () => void this.#everyCallback.delete(handler);
  }

  /** Forgets every callback handler. The count of misses is kept. */
  clearCallbacks(): void {
    this.#callbacks.clear();
    this.#everyCallback.clear();
  }

  /**
   * How many callbacks fired with nothing registered under their name. Not
   * a failure: the author and the host declare their halves independently,
   * and a story plays the same with nobody listening.
   */
  get callbackMisses(): number {
    return this.#misses;
  }

  start(): void {
    this.#run('start', () => this.session.start());
  }

  /**
   * Takes the choice at `index` among those offered. With none, the reader
   * leaves: the passage flows nowhere and the story ends there.
   */
  choose(index?: number): void {
    this.#run('choose', () => this.session.choose(index));
  }

  /** Answers the prompt showing. With none, the reader leaves, as with `choose()`. */
  answer(values?: Answers): void {
    this.#run('answer', () => this.session.answer(values));
  }

  /**
   * The reader's answer about one kind, at any time — before `start`, for a
   * host that remembers it, and then nobody is asked. On a `permit` turn the
   * answer to the last kind begins the story. A pending wait or countdown
   * runs on: an answer moves nothing.
   */
  permit(kind: PermissionKind, granted: boolean): void {
    if (this.#disposed) return;
    this.#enter('permit');
    if (granted) this.#granted.add(kind);
    else this.#granted.delete(kind);
    this.#dispatch(this.#stamped(() => this.session.permit(kind, granted)));
  }

  /**
   * The reader's stand-in for `kind`, as they typed it, or `undefined` to
   * take it away — `Session.setStandIn`. One that does not read throws a
   * `HostError`, and the one before stays. A time typed without an offset
   * is read at `localOffsetMinutes`, this machine's own unless given.
   */
  setStandIn(kind: PermissionKind, typed?: string, localOffsetMinutes?: number): void {
    if (this.#disposed) return;
    this.session.setStandIn(kind, typed, localOffsetMinutes);
  }

  /**
   * The host's last position fix, or `undefined` for none — `Session.setPosition`.
   * A `HostError` once the reader has said no to `location`.
   */
  setPosition(fix?: Position): void {
    if (this.#disposed) return;
    this.session.setPosition(fix);
  }

  /**
   * Says the showing passage's countdown begins, for a host that runs it
   * itself (`countdowns: false`). With `countdowns` on, the player says it
   * when the time comes; calling it takes the countdown over.
   */
  beginCountdown(): void {
    if (this.#disposed) return;
    this.#enter('beginCountdown');
    this.#dropCountdown();
    this.#dispatch(this.#stamped(() => this.session.beginCountdown()));
  }

  /** Says the showing passage's countdown ran out: its default is taken. */
  expire(): void {
    this.#run('expire', () => this.session.expire());
  }

  /**
   * Reads on in another language. The passage or prompt showing is shown
   * again in it, and a pending wait or countdown runs on: it is the same
   * visit.
   */
  setLocale(locale: string): void {
    if (this.#disposed) return;
    this.#enter('setLocale');
    this.#dispatch(
      this.#stamped(() => this.session.setLocale(locale)),
      true,
    );
  }

  restart(): void {
    this.#run('restart', () => this.session.restart());
  }

  /**
   * Puts the story down and answers its save, as `Session.pause` does —
   * `undefined`, and nothing stopped, unless the story is on a passage or a
   * prompt. It still answers after `dispose`, so a page can save on its way
   * out. Not `SoundscapeDriver.pause`.
   */
  pause(): string | undefined {
    this.#enter('pause');
    this.#cancel();
    const paused = this.session.pause();
    this.#dispatch(paused.effects);
    return paused.save;
  }

  stop(): void {
    this.#run('stop', () => this.session.stop());
  }

  /**
   * One line of Python against the live story, the way a playthrough
   * console runs it. What it led to — a variable written, a cue played — is
   * delivered like any verb's effects.
   */
  consoleFeed(code: string): PythonResult {
    this.#enter('consoleFeed');
    const fed = this.#stamped(() => this.session.consoleFeed(code));
    this.#dispatch(fed.effects);
    return fed.result;
  }

  /**
   * Stops waiting on any hold or countdown and delivers nothing more. After
   * it, every verb does nothing at all — the story does not move — and
   * `pause` still answers a save.
   */
  dispose(): void {
    this.#cancel();
    this.#disposed = true;
  }

  #run(name: string, verb: () => Effect[]): void {
    // Moving a story nobody will hear about would leave the page drawing a
    // turn the session has already left.
    if (this.#disposed) return;
    this.#enter(name);
    this.#cancel();
    this.#dispatch(this.#stamped(verb));
  }

  /** Runs `verb` after telling the engine what time it is, if it may know. */
  #stamped<T>(verb: () => T): T {
    if (this.#granted.has('dateTime')) {
      this.session.setNow((this.handlers.now ?? momentOf)());
    }
    return verb();
  }

  #enter(verb: string): void {
    if (this.#delivering) throw new ReentrantVerb(verb);
  }

  /** Delivers a batch. `rerender` is a change of language's, the same visit to the same turn. */
  #dispatch(effects: readonly Effect[], rerender = false): void {
    if (this.#disposed) return;
    this.#delivering = true;
    try {
      for (const effect of effects) {
        // A handler may dispose of the player; nothing more is delivered.
        if (this.#disposed) return;
        if (isTurn(effect)) this.#turn = effect;
        if (effect.kind === 'audio') {
          const command = effect.command;
          this.#absorb(() => this.handlers.audio?.apply(command));
        }
        if (effect.kind === 'callback') this.#fire(effect.event);
        this.#absorb(() => this.handlers.onEffect(effect));
      }
    } finally {
      this.#delivering = false;
    }
    if (this.#disposed) return;
    const last = effects.at(-1);
    if (last?.kind === 'hold') {
      if (this.#timer !== undefined) clearTimeout(this.#timer);
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#later(() => this.session.elapsed());
      }, last.ms);
    }
    // A new turn is a new visit, and whatever was counting down was the last
    // one's; a re-render is the same visit, and its countdown runs on.
    if (!rerender && last !== undefined && isTurn(last)) {
      this.#dropCountdown();
      const timer = last.kind === 'show' ? last.passage.timer : undefined;
      if (timer && this.handlers.countdowns !== false) this.#count(timer);
    }
  }

  // Waits the timer's `afterMs`, begins it, waits its `timeoutMs`, runs it
  // out. Each wait is dropped the moment the story moves.
  #count(timer: ChoiceTimer): void {
    this.#tell({ timer, begun: false });
    this.#countdownTimer = setTimeout(() => {
      this.#countdownTimer = undefined;
      this.#later(() => this.session.beginCountdown());
      if (this.#disposed || this.#countdown?.timer !== timer) return;
      this.#tell({ timer, begun: true });
      this.#countdownTimer = setTimeout(() => {
        this.#countdownTimer = undefined;
        this.#dropCountdown();
        this.#later(() => this.session.expire());
      }, timer.timeoutMs);
    }, timer.afterMs);
  }

  #tell(countdown: Countdown | undefined): void {
    this.#countdown = countdown;
    const told = this.handlers.onCountdown;
    if (told) this.#absorb(() => told(countdown));
  }

  /** Forgets the countdown running, if any, and says so. */
  #dropCountdown(): void {
    if (this.#countdownTimer !== undefined) clearTimeout(this.#countdownTimer);
    this.#countdownTimer = undefined;
    if (this.#countdown !== undefined) this.#tell(undefined);
  }

  // A verb the player makes by itself, from a timer: nothing of the host's
  // is on the stack to catch what it throws.
  #later(verb: () => Effect[]): void {
    try {
      this.#dispatch(this.#stamped(verb));
    } catch (error) {
      if (this.handlers.onError) this.handlers.onError(error);
      else throw error;
    }
  }

  #fire(fired: CallbackEvent): void {
    const handler = this.#callbacks.get(fired.callback);
    if (handler) this.#absorb(() => handler(fired));
    else this.#misses++;
    for (const every of this.#everyCallback) this.#absorb(() => every(fired));
  }

  // A handler's error is the host's bug and not the story's: it is reported,
  // and the rest of the batch is still delivered.
  #absorb(handler: () => void): void {
    try {
      handler();
    } catch (error) {
      if (this.handlers.onError) this.handlers.onError(error);
      else if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
      else console.error(error);
    }
  }

  #cancel(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#dropCountdown();
  }
}

export function isTurn(effect: Effect): effect is Turn {
  switch (effect.kind) {
    case 'show':
    case 'ask':
    case 'permit':
    case 'hold':
    case 'ended':
    case 'failed':
    case 'stopped':
      return true;
    default:
      return false;
  }
}
