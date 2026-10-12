// What a soundscape is played through: the contract between the engine's
// scheduler, which decides, and whatever makes the sound, which obeys
// (`host-audio-system.md` §9, transcribed in docs/speaker.md).
//
// A `Speaker` hands out voices; a `Voice` plays one file as it is told and
// says when it ran out and how long the file is. Everything else a host owes
// the scheduler — the timer, a late voice's entry point, a looping bed's
// arithmetic, gains written before a voice was ready, files nobody can
// resolve — is the `SoundscapeDriver`'s, written once, so that a speaker is
// only ever the part that touches an audio API. `@ripplefx/soundscape` is the
// Web Audio one; a page with an audio engine of its own implements this.

/** What a voice is to play, in milliseconds of the file and the gain scale. */
export interface VoicePlay {
  /** Where in the file to begin. */
  readonly from: number;
  /** Where to stop, or the file's end when absent. */
  readonly to?: number;
  /**
   * How loud, from 0 to 1, on the engine's gain scale (`host-audio-system.md`
   * §9): a level whose curve is cubic, as mpv's volume control is, which is
   * what the author heard it through. A speaker writing amplitude writes
   * `gain ** 3`, or a soundscape mixes louder in its quiet parts than the
   * author heard it.
   */
  readonly gain: number;
  /** Playback speed, 1 being as recorded. */
  readonly rate: number;
  /** Whether a turn that reaches `to` comes round again. */
  readonly looping: boolean;
  /** Where each turn of a loop comes round to — not `from`. */
  readonly loopFrom: number;
}

/** One play of one file. */
export interface Voice {
  /**
   * Begins at once, replacing whatever this voice was playing. Called again
   * on the same voice for a bed whose file ended and comes round gaplessly.
   */
  play(request: VoicePlay): void;
  /** Writes a new gain, on the same scale as `VoicePlay.gain`. */
  setGain(gain: number): void;
  pause(): void;
  resume(): void;
  /** Ends the voice for good. No `onEnded` follows. */
  stop(): void;
  /** Set by the driver: the voice reached the end of what it was given. */
  onEnded?: () => void;
  /** Set by the driver: the file's length, once the decoder knows it. */
  onDuration?: (ms: number) => void;
}

/** A soundscape track, which may run for minutes, or a cue, which is short. */
export type VoiceRole = 'track' | 'cue';

export interface Speaker {
  /**
   * A voice for the file at `url`, resolving once it can begin at once. A
   * file that cannot be played rejects, and is heard as silence.
   */
  voice(url: URL, role: VoiceRole): Promise<Voice>;
}
