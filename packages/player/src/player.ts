// The loop over a session, written once: the safe way to play a campaign.
//
// A `Player` hands every effect to the host's listener in order, keeps the
// turn the last one named, and is the host's clock for a `hold` — it waits
// the milliseconds the story asked for and says `elapsed` (§14 of the host
// API asks a host to route a hold to its own clock, and this is that). A
// verb while a hold is pending cancels the wait first, so a restart during a
// pause in the story does not wake the story up again a moment later.
import type { Effect, Turn } from './effects.js';
import type { Answers, Session } from './session.js';
import type { SoundscapeDriver } from './soundscape.js';

export interface PlayerHandlers {
  /** Every effect, in the order the engine produced it. */
  readonly onEffect: (effect: Effect) => void;
  /**
   * An error from a verb the player made by itself — the `elapsed` after a
   * hold. A verb the host calls throws to the host instead.
   */
  readonly onError?: (error: unknown) => void;
  /**
   * Where the story's sound goes. Every `audio` effect is applied to it as
   * well as handed to `onEffect`; without one, nothing is heard.
   */
  readonly audio?: SoundscapeDriver;
}

export class Player {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #turn: Turn | undefined;
  #disposed = false;

  constructor(
    readonly session: Session,
    readonly handlers: PlayerHandlers,
  ) {}

  /** Where the story is: the last passage, prompt, wait or ending shown. */
  get turn(): Turn | undefined {
    return this.#turn;
  }

  start(): void {
    this.#run(() => this.session.start());
  }

  choose(index?: number): void {
    this.#run(() => this.session.choose(index));
  }

  answer(values?: Answers): void {
    this.#run(() => this.session.answer(values));
  }

  setLocale(locale: string): void {
    this.#run(() => this.session.setLocale(locale));
  }

  restart(): void {
    this.#run(() => this.session.restart());
  }

  /** Puts the story down and answers its save. */
  pause(): string | undefined {
    this.#cancel();
    const paused = this.session.pause();
    this.#dispatch(paused.effects);
    return paused.save;
  }

  stop(): void {
    this.#run(() => this.session.stop());
  }

  /** Stops waiting on any hold and delivers nothing more. */
  dispose(): void {
    this.#cancel();
    this.#disposed = true;
  }

  #run(verb: () => Effect[]): void {
    this.#cancel();
    this.#dispatch(verb());
  }

  #dispatch(effects: readonly Effect[]): void {
    if (this.#disposed) return;
    for (const effect of effects) {
      if (isTurn(effect)) this.#turn = effect;
      if (effect.kind === 'audio') this.handlers.audio?.apply(effect.command);
      this.handlers.onEffect(effect);
    }
    const last = effects.at(-1);
    if (last?.kind === 'hold') {
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
