// @ripplefx/soundscape — a campaign's soundscapes, played with Web Audio.
//
//   const speaker = new WebAudioSpeaker();
//   const audio = new SoundscapeDriver(campaign, speaker);
//   begin.onclick = async () => { await speaker.unlock(); player.start(); };
//
// The scheduling is the engine's and the host's duties are the driver's, both
// in @ripplefx/player; this is only the part that makes a sound, written
// against the `Speaker` contract (docs/speaker.md). Two kinds of voice,
// because a soundscape has two kinds of file:
//
// - **A track streams** through a media element into a gain node. A music
//   bed of a few minutes decoded into an AudioBuffer is about 23 MB a minute
//   of float samples; four of them would be most of a gigabyte, and a phone
//   closes the tab long before. A media element reads the file as it plays.
// - **A cue is decoded**, once, and started from its buffer, because a sound
//   effect that begins a beat late is the one lateness anybody hears.
//
// Every gain goes through a GainNode, never `HTMLMediaElement.volume`, which
// iOS ignores.
import type { Speaker, Voice, VoicePlay, VoiceRole } from '@ripplefx/player';

export interface WebAudioSpeakerOptions {
  /** The context to play in; a new one otherwise. */
  readonly context?: AudioContext;
  /** Where every voice goes; the context's speakers otherwise. */
  readonly destination?: AudioNode;
  /**
   * The CORS mode for a file on another origin. A media element without one
   * is played, but a gain node hears it as silence, as the browser requires.
   */
  readonly crossOrigin?: 'anonymous' | 'use-credentials';
  /** How many decoded cues are kept for the next time they are cued. */
  readonly cueCache?: number;
}

/**
 * A gain on the editor's scale as an amplitude. The editor writes a gain to
 * mpv's volume control, whose curve is cubic, so this does the same: half
 * the gain is an eighth of the amplitude, as the author heard it.
 */
export function amplitude(gain: number): number {
  const level = Math.min(1, Math.max(0, Number.isFinite(gain) ? gain : 0));
  return level ** 3;
}

// How quickly a new gain is reached. The scheduler writes one every tick, a
// step at a time; reaching each over a few milliseconds is what keeps a fade
// from being a staircase you can hear.
const SMOOTHING = 0.012;

export class WebAudioSpeaker implements Speaker {
  readonly context: AudioContext;
  readonly #destination: AudioNode;
  readonly #crossOrigin: 'anonymous' | 'use-credentials';
  readonly #cueCache: number;
  readonly #buffers = new Map<string, Promise<AudioBuffer>>();

  constructor(options: WebAudioSpeakerOptions = {}) {
    this.context = options.context ?? new AudioContext();
    this.#destination = options.destination ?? this.context.destination;
    this.#crossOrigin = options.crossOrigin ?? 'anonymous';
    this.#cueCache = options.cueCache ?? 32;
  }

  /**
   * Lets the context make a sound. Browsers start none before the reader has
   * clicked, tapped or pressed a key on the page, so call this from the
   * handler of that gesture — a *Begin* button.
   */
  async unlock(): Promise<void> {
    if (this.context.state !== 'running') await this.context.resume();
  }

  voice(url: URL, role: VoiceRole): Promise<Voice> {
    return role === 'cue' ? this.#cue(url) : this.#track(url);
  }

  /** Closes the context; nothing plays through this speaker afterwards. */
  async close(): Promise<void> {
    this.#buffers.clear();
    await this.context.close();
  }

  async #track(url: URL): Promise<Voice> {
    const element = new Audio();
    element.preload = 'auto';
    if (globalThis.location === undefined || url.origin !== globalThis.location.origin) {
      element.crossOrigin = this.#crossOrigin;
    }
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        element.removeEventListener('loadedmetadata', loaded);
        element.removeEventListener('error', failed);
      };
      const loaded = () => {
        done();
        resolve();
      };
      const failed = () => {
        done();
        reject(
          new Error(
            `${url.href} could not be played: ${element.error?.message ?? 'unknown error'}`,
          ),
        );
      };
      element.addEventListener('loadedmetadata', loaded);
      element.addEventListener('error', failed);
      element.src = url.href;
    });
    return new TrackVoice(this.context, this.#destination, element);
  }

  async #cue(url: URL): Promise<Voice> {
    let buffer = this.#buffers.get(url.href);
    if (buffer) {
      // Most recently used goes last; the oldest is let go of first.
      this.#buffers.delete(url.href);
    } else {
      buffer = fetch(url, { mode: 'cors' })
        .then((response) => {
          if (!response.ok) throw new Error(`${url.href} answered ${response.status}`);
          return response.arrayBuffer();
        })
        .then((bytes) => this.context.decodeAudioData(bytes));
      buffer.catch(() => this.#buffers.delete(url.href));
    }
    this.#buffers.set(url.href, buffer);
    while (this.#buffers.size > this.#cueCache) {
      const oldest = this.#buffers.keys().next().value;
      if (oldest === undefined) break;
      this.#buffers.delete(oldest);
    }
    return new CueVoice(this.context, this.#destination, await buffer);
  }
}

/** A track: a media element, streaming, into a gain node. */
class TrackVoice implements Voice {
  onEnded?: () => void;
  onDuration?: (ms: number) => void;
  readonly #context: AudioContext;
  readonly #element: HTMLAudioElement;
  #source: MediaElementAudioSourceNode | undefined;
  readonly #gain: GainNode;
  #request: VoicePlay | undefined;
  #watch: ReturnType<typeof setInterval> | undefined;
  #held = false;
  #stopped = false;
  #durationSent = false;
  // Whether this play has reported its end — once, whichever of the
  // element's `ended` and the watcher saw it first.
  #finished = false;

  constructor(context: AudioContext, destination: AudioNode, element: HTMLAudioElement) {
    this.#context = context;
    this.#element = element;
    this.#gain = context.createGain();
    this.#gain.gain.value = 0;
    this.#gain.connect(destination);
    // Muted until it is routed into the gain node, which happens once it is
    // playing — see `#route`.
    element.muted = true;
    element.addEventListener('ended', () => this.#reachedEnd());
    element.addEventListener('durationchange', () => this.#sendDuration());
  }

  play(request: VoicePlay): void {
    if (this.#stopped) return;
    this.#request = request;
    this.#finished = false;
    const element = this.#element;
    element.playbackRate = request.rate > 0 ? request.rate : 1;
    // A loop over the whole file is the element's own, and seamless as the
    // browser can make it; any other loop is the watcher's.
    element.loop = request.looping && request.to === undefined && request.loopFrom === 0;
    element.currentTime = request.from / 1000;
    this.#gain.gain.cancelScheduledValues(this.#context.currentTime);
    this.#gain.gain.setValueAtTime(amplitude(request.gain), this.#context.currentTime);
    this.#watching();
    this.#sendDuration();
    if (!this.#held) this.#start();
  }

  #start(): void {
    void this.#element.play().then(
      () => this.#route(),
      () => {},
    );
  }

  // **The element is routed into Web Audio once it is playing, not before.**
  // WebKitGTK stalls an element routed while it is still loading — it plays
  // silently at time 0 for ever — and every engine, that one included, takes
  // the route once playback has begun. It stays muted until then, so not a
  // frame of it is heard at the wrong gain.
  #route(): void {
    if (this.#source || this.#stopped) return;
    this.#source = this.#context.createMediaElementSource(this.#element);
    this.#source.connect(this.#gain);
    this.#element.muted = false;
  }

  setGain(gain: number): void {
    if (this.#stopped) return;
    this.#gain.gain.setTargetAtTime(amplitude(gain), this.#context.currentTime, SMOOTHING);
  }

  pause(): void {
    this.#held = true;
    this.#element.pause();
  }

  resume(): void {
    this.#held = false;
    if (!this.#stopped && this.#request) this.#start();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#unwatch();
    this.#element.pause();
    this.#source?.disconnect();
    this.#gain.disconnect();
    this.#element.removeAttribute('src');
    this.#element.load();
  }

  #sendDuration(): void {
    const seconds = this.#element.duration;
    if (this.#durationSent || !Number.isFinite(seconds) || !this.onDuration) return;
    this.#durationSent = true;
    this.onDuration(seconds * 1000);
  }

  // A clip that ends before the file does, or loops back to somewhere other
  // than the start, is enforced here: no media element knows either. So is
  // a file's own end, because WebKitGTK never fires `ended` for an element
  // routed into Web Audio. A forty-millisecond look is coarser than a sample
  // and finer than a beat.
  #watching(): void {
    this.#unwatch();
    const request = this.#request;
    if (!request || this.#element.loop) return;
    this.#watch = setInterval(() => {
      if (this.#held || this.#finished) return;
      const element = this.#element;
      const at = element.currentTime * 1000;
      const end =
        request.to ?? (Number.isFinite(element.duration) ? element.duration * 1000 : undefined);
      if (end === undefined) return;
      const reached = request.to === undefined ? element.ended || at >= end - 20 : at >= end;
      if (!reached) return;
      if (request.looping) {
        element.currentTime = request.loopFrom / 1000;
        if (element.paused) this.#start();
      } else {
        this.#finish();
      }
    }, 40);
  }

  #unwatch(): void {
    if (this.#watch !== undefined) clearInterval(this.#watch);
    this.#watch = undefined;
  }

  #reachedEnd(): void {
    if (this.#stopped) return;
    const request = this.#request;
    if (request?.looping) {
      // The file ran out inside a loop that comes round somewhere other
      // than its start.
      this.#element.currentTime = request.loopFrom / 1000;
      this.#start();
      return;
    }
    this.#finish();
  }

  #finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#unwatch();
    this.#element.pause();
    this.onEnded?.();
  }
}

/** A cue: a decoded buffer, started at once, its position kept by hand. */
class CueVoice implements Voice {
  onEnded?: () => void;
  onDuration?: (ms: number) => void;
  readonly #context: AudioContext;
  readonly #buffer: AudioBuffer;
  readonly #gain: GainNode;
  #node: AudioBufferSourceNode | undefined;
  #request: VoicePlay | undefined;
  #startedAt = 0;
  #offset = 0;
  #held = false;
  #stopped = false;

  constructor(context: AudioContext, destination: AudioNode, buffer: AudioBuffer) {
    this.#context = context;
    this.#buffer = buffer;
    this.#gain = context.createGain();
    this.#gain.gain.value = 0;
    this.#gain.connect(destination);
  }

  play(request: VoicePlay): void {
    if (this.#stopped) return;
    this.#request = request;
    this.#gain.gain.cancelScheduledValues(this.#context.currentTime);
    this.#gain.gain.setValueAtTime(amplitude(request.gain), this.#context.currentTime);
    this.onDuration?.(this.#buffer.duration * 1000);
    this.#offset = request.from / 1000;
    if (!this.#held) this.#start();
  }

  setGain(gain: number): void {
    if (this.#stopped) return;
    this.#gain.gain.setTargetAtTime(amplitude(gain), this.#context.currentTime, SMOOTHING);
  }

  // A buffer source cannot pause: the position is taken, the source let go
  // of, and a new one started from it on resume.
  pause(): void {
    if (this.#held) return;
    this.#held = true;
    if (!this.#node) return;
    this.#offset = this.#position();
    this.#release();
  }

  resume(): void {
    if (!this.#held) return;
    this.#held = false;
    if (!this.#stopped && this.#request) this.#start();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#release();
    this.#gain.disconnect();
  }

  #start(): void {
    const request = this.#request;
    if (!request) return;
    this.#release();
    const node = this.#context.createBufferSource();
    node.buffer = this.#buffer;
    node.playbackRate.value = request.rate > 0 ? request.rate : 1;
    const end =
      request.to === undefined
        ? this.#buffer.duration
        : Math.min(request.to / 1000, this.#buffer.duration);
    node.connect(this.#gain);
    if (request.looping) {
      node.loop = true;
      node.loopStart = request.loopFrom / 1000;
      node.loopEnd = end;
      node.start(0, this.#offset);
    } else {
      node.start(0, this.#offset, Math.max(0, end - this.#offset));
    }
    node.onended = () => {
      if (this.#node !== node || this.#held || this.#stopped) return;
      this.#node = undefined;
      this.onEnded?.();
    };
    this.#node = node;
    this.#startedAt = this.#context.currentTime;
  }

  #position(): number {
    const request = this.#request;
    const rate = request && request.rate > 0 ? request.rate : 1;
    const played = this.#offset + (this.#context.currentTime - this.#startedAt) * rate;
    if (!request?.looping) return played;
    const start = request.loopFrom / 1000;
    const end = request.to === undefined ? this.#buffer.duration : request.to / 1000;
    const span = end - start;
    return played <= end || span <= 0 ? played : start + ((played - start) % span);
  }

  #release(): void {
    const node = this.#node;
    if (!node) return;
    this.#node = undefined;
    node.onended = null;
    try {
      node.stop();
    } catch {
      // Never started, or already over.
    }
    node.disconnect();
  }
}
