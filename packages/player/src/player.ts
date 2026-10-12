// The loop over a session, written once: the safe way to play a campaign.
//
// A `Player` hands every effect to the host's listener in order, keeps the
// turn the last one named, and is the host's clock for a `hold` — it waits
// the milliseconds the story asked for and says `elapsed` (§14 of the host
// API asks a host to route a hold to its own clock, and this is that). A
// verb while a hold is pending cancels the wait first, so a restart during a
// pause in the story does not wake the story up again a moment later.
//
// It is also the host-side table the author's named callbacks are dispatched
// through (`campaign-host-api.md` §5b): a handler registered under a name is
// called where the engine placed the callback in its batch, a name nobody
// registered is counted and nothing more, and a handler that throws is
// reported and the batch goes on — the host's to absorb, because the verb is
// still delivering the rest of what it led to.
import type { CallbackEvent, Effect, Turn } from './effects.js';
import { RippleError } from './errors.js';
import type { Answers, PythonResult, Session } from './session.js';
import type { SoundscapeDriver } from './soundscape.js';

export interface PlayerHandlers {
  /** Every effect, in the order the engine produced it. */
  readonly onEffect: (effect: Effect) => void;
  /**
   * An error from a verb the player made by itself — the `elapsed` after a
   * hold — or thrown by a handler while a batch was being delivered: by
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
  #turn: Turn | undefined;
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

  /** Where the story is: the last passage, prompt, wait or ending shown. */
  get turn(): Turn | undefined {
    return this.#turn;
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

  setLocale(locale: string): void {
    this.#run('setLocale', () => this.session.setLocale(locale));
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
    const fed = this.session.consoleFeed(code);
    this.#dispatch(fed.effects);
    return fed.result;
  }

  /**
   * Stops waiting on any hold and delivers nothing more. After it, `start`,
   * `choose`, `answer`, `setLocale`, `restart` and `stop` do nothing at all
   * — the story does not move — and `pause` still answers a save.
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
    this.#dispatch(verb());
  }

  #enter(verb: string): void {
    if (this.#delivering) throw new ReentrantVerb(verb);
  }

  #dispatch(effects: readonly Effect[]): void {
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
    const last = effects.at(-1);
    if (last?.kind === 'hold' && !this.#disposed) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        try {
          this.#dispatch(this.session.elapsed());
        } catch (error) {
          if (this.handlers.onError) this.handlers.onError(error);
          else throw error;
        }
      }, last.ms);
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
  }
}

export function isTurn(effect: Effect): effect is Turn {
  switch (effect.kind) {
    case 'show':
    case 'ask':
    case 'hold':
    case 'ended':
    case 'failed':
    case 'stopped':
      return true;
    default:
      return false;
  }
}
