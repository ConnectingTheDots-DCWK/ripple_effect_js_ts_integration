// The host's half of the soundscape scheduler, written once.
//
// The scheduler is the engine's — the component's `mixer`, the same one the
// editor drives — and decides every voice, gain and handover from a clock it
// is handed (`host-audio-system.md` §§3–6). This drives it: forwards the
// session's audio commands, ticks it while anything sounds, and applies what
// it answers to a `Speaker`, doing for it everything §9 says a host owes the
// scheduler. It is the editor's adapter (`SoundscapeMixer` in
// packages/ripple_audio_engine) ported, without the awaits a Dart engine
// needed: a voice is the one thing that takes a while, and only its opening
// is waited on.
import type {
  Mixer,
  VoiceCommand,
  VoiceOpen,
} from '../generated/no-python/interfaces/ripple-engine-mixer.js';
import type { Campaign } from './campaign.js';
import { type AudioCommand, engineSoundscapes } from './effects.js';
import { RippleError } from './errors.js';
import type { Speaker, Voice } from './speaker.js';

export interface SoundscapeOptions {
  /** How many cues may sound at once; the oldest gives way. The editor's is 8. */
  readonly maxCues?: number;
  /** The smallest change of gain worth writing. The editor's is 0.004. */
  readonly gainStep?: number;
  /** How often the scheduler is ticked while anything sounds. The editor's is 25 ms. */
  readonly tickMs?: number;
  /** Starts muted: every gain written as zero, and remembered. */
  readonly muted?: boolean;
  /** The clock, in milliseconds, monotonic. `performance.now` unless a test says. */
  readonly now?: () => number;
}

interface Slot {
  readonly ready: Promise<Voice>;
  voice?: Voice;
  pendingGain?: number;
  readonly wantsDuration: boolean;
  durationReported: boolean;
}

export class SoundscapeDriver {
  readonly #campaign: Campaign;
  readonly #speaker: Speaker;
  readonly #mixer: Mixer;
  readonly #slots = new Map<bigint, Slot>();
  readonly #tickMs: number;
  readonly #now: () => number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #disposed = false;

  constructor(campaign: Campaign, speaker: Speaker, options: SoundscapeOptions = {}) {
    this.#campaign = campaign;
    this.#speaker = speaker;
    this.#tickMs = options.tickMs ?? 25;
    this.#now = options.now ?? (() => performance.now());
    this.#mixer = campaign.engine.call(
      (root) => new root.mixer.Mixer(options.maxCues ?? 8, options.gainStep ?? 0.004),
    );
    if (options.muted) this.setMuted(true);
  }

  /**
   * Obeys one of the session's audio commands — the very object an `audio`
   * effect carried, or a soundscape `Campaign.soundscape` answered. **A
   * `play` whose soundscape was copied, rebuilt or parsed from JSON throws**:
   * the scheduler is handed the engine's own record of it, and only the
   * original object leads back to that.
   */
  apply(command: AudioCommand): void {
    if (this.#disposed) return;
    switch (command.kind) {
      case 'play': {
        const raw = engineSoundscapes.get(command.soundscape);
        if (!raw) {
          throw new RippleError(
            `the soundscape ${command.soundscape.id} was not handed out by this package: apply the effect's own object, not a copy`,
          );
        }
        // A track whose file the page cannot find is heard as silence and
        // never retried (§9) — told to the scheduler rather than tried.
        const unresolved = command.soundscape.tracks.flatMap((track, index) =>
          this.#campaign.mediaUrl(track.media) === undefined ? [index] : [],
        );
        this.#run((mixer) =>
          mixer.play(this.#clock(), raw, Uint32Array.from(unresolved), 0n, this.muted),
        );
        break;
      }
      case 'stop':
        this.#run((mixer) => mixer.stop(this.#clock()));
        break;
      case 'cut':
        this.#run((mixer) => mixer.cut(this.#clock()));
        break;
      case 'cue':
        // A cue with no file is ignored, as the editor does.
        if (command.url === undefined) return;
        this.#run((mixer) =>
          mixer.cue(this.#clock(), command.media, command.volume, command.speed),
        );
        break;
    }
  }

  /** Mutes or unmutes at once; the gains the scheduler would have written are kept. */
  setMuted(muted: boolean): void {
    this.#call((mixer) => mixer.setMuted(muted));
    this.#tick();
  }

  get muted(): boolean {
    return this.#call((mixer) => mixer.muted());
  }

  /**
   * Holds every voice where it is, and the clock with them — a page hidden,
   * say. The story is not touched: not `Player.pause`, which puts the story
   * down.
   */
  pause(): void {
    this.#run((mixer) => mixer.pause(this.#clock()));
  }

  resume(): void {
    this.#run((mixer) => mixer.resume(this.#clock()));
  }

  /**
   * The id of the soundscape in force: the one sounding, or the one waiting
   * its turn while the last fades out.
   */
  get playing(): string | undefined {
    return this.#call((mixer) => mixer.playingId());
  }

  /** Whether nothing sounds, waits or cues. */
  get idle(): boolean {
    return this.#call((mixer) => mixer.isIdle());
  }

  /** Stops everything and lets every voice go. */
  dispose(): void {
    if (this.#disposed) return;
    this.#run((mixer) => mixer.cut(this.#clock()));
    this.#disposed = true;
    this.#stopTicking();
    for (const id of [...this.#slots.keys()]) this.#stop(id);
  }

  #clock(): bigint {
    return BigInt(Math.max(0, Math.round(this.#now())));
  }

  #call<T>(body: (mixer: Mixer) => T): T {
    return this.#campaign.engine.call(() => body(this.#mixer));
  }

  #run(verb: (mixer: Mixer) => VoiceCommand[]): void {
    if (this.#disposed) return;
    this.#obey(this.#call(verb));
    this.#ensureTicking();
  }

  #obey(commands: readonly VoiceCommand[]): void {
    for (const command of commands) {
      if (this.#disposed) return;
      switch (command.tag) {
        case 'open':
          void this.#open(command.val);
          break;
        case 'gain': {
          const slot = this.#slots.get(command.val.voice);
          if (!slot) break;
          // Not open yet: written the moment it is.
          if (slot.voice) slot.voice.setGain(command.val.gain);
          else slot.pendingGain = command.val.gain;
          break;
        }
        case 'stop':
          this.#stop(command.val);
          break;
        case 'pause':
          this.#stopTicking();
          for (const slot of this.#slots.values()) slot.voice?.pause();
          break;
        case 'resume':
          for (const slot of this.#slots.values()) slot.voice?.resume();
          break;
      }
    }
  }

  async #open(open: VoiceOpen): Promise<void> {
    const id = open.voice;
    const url = this.#campaign.mediaUrl(open.media);
    if (url === undefined) {
      // Not a file the scheduler was told is missing: the same silence an
      // unresolved track is, reported so the id is let go of.
      this.#ended(id, true);
      return;
    }
    const play = (from: number) => ({
      from,
      gain: open.gain,
      rate: open.rate,
      looping: open.looping,
      loopFrom: Number(open.loopFromMs),
      ...(open.toMs === undefined ? {} : { to: Number(open.toMs) }),
    });
    const existing = this.#slots.get(id);
    if (existing) {
      // A gapless bed whose file ended, given it again on the same voice.
      const voice = existing.voice ?? (await existing.ready.catch(() => undefined));
      if (voice && this.#slots.get(id) === existing) voice.play(play(Number(open.fromMs)));
      return;
    }
    const issued = this.#now();
    const slot: Slot = {
      ready: this.#speaker.voice(url, open.role.tag),
      wantsDuration: open.role.tag === 'track' && open.toMs === undefined,
      durationReported: false,
    };
    this.#slots.set(id, slot);
    let voice: Voice;
    try {
      voice = await slot.ready;
    } catch {
      // A file that would not play is heard the way one that ended is.
      if (this.#slots.get(id) === slot) {
        this.#slots.delete(id);
        this.#ended(id, true);
      }
      return;
    }
    if (this.#disposed || this.#slots.get(id) !== slot) {
      // Let go of while the voice was coming.
      voice.stop();
      return;
    }
    // How late the voice came is the host's to add (§9): `from` was right
    // when the scheduler answered, and the sound should agree with the clock
    // as it is now. The ramps do not move; they are measured from when the
    // track was due.
    let from = Number(open.fromMs) + (this.#now() - issued) * open.rate;
    const to = open.toMs === undefined ? undefined : Number(open.toMs);
    const loopFrom = Number(open.loopFromMs);
    if (to !== undefined) {
      if (open.looping) {
        // A bed has been round some number of times meanwhile.
        const clip = to - loopFrom;
        if (clip > 0 && from > to) from = loopFrom + ((from - loopFrom) % clip);
      } else if (from >= to) {
        // Over by the time the voice came: heard, as far as the clock goes.
        this.#slots.delete(id);
        voice.stop();
        this.#ended(id, true);
        return;
      }
    }
    slot.voice = voice;
    voice.onEnded = () => this.#ended(id, false);
    voice.onDuration = (ms) => {
      if (!slot.wantsDuration || slot.durationReported || this.#slots.get(id) !== slot) return;
      slot.durationReported = true;
      this.#call((mixer) => mixer.durationKnown(id, BigInt(Math.round(ms))));
    };
    voice.play(play(from));
    if (slot.pendingGain !== undefined) {
      voice.setGain(slot.pendingGain);
      delete slot.pendingGain;
    }
    this.#ensureTicking();
  }

  // `unknown` is a voice the scheduler is told about without one ever having
  // sounded — no slot to look for.
  #ended(id: bigint, unknown: boolean): void {
    if (this.#disposed || (!unknown && !this.#slots.has(id))) return;
    this.#run((mixer) => mixer.voiceEnded(this.#clock(), id));
  }

  // The slot goes before the voice is stopped, so a second stop on the same
  // tick — a clip's end and the timeline's cut together — finds nothing.
  #stop(id: bigint): void {
    const slot = this.#slots.get(id);
    if (!slot) return;
    this.#slots.delete(id);
    if (slot.voice) slot.voice.stop();
    else
      slot.ready.then(
        (voice) => voice.stop(),
        () => {},
      );
  }

  #tick(): void {
    if (this.#disposed) return;
    this.#obey(this.#call((mixer) => mixer.tick(this.#clock())));
    if (this.idle) this.#stopTicking();
  }

  #ensureTicking(): void {
    if (this.#disposed || this.#timer !== undefined || this.idle) return;
    if (this.#call((mixer) => mixer.isPaused())) return;
    this.#timer = setInterval(() => this.#tick(), this.#tickMs);
  }

  #stopTicking(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
