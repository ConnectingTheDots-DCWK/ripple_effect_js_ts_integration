// The soundscape driver against a speaker that only writes down what it was
// told, on a clock that is a number. What is pinned is the host's half of
// `host-audio-system.md` §9 — the scheduler's own rules are the engine's and
// tested there; these are what a speaker would see if the driver got them
// wrong.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { engineSoundscapes, toSoundscape } from '../src/effects.ts';
import {
  Campaign,
  Player,
  RippleError,
  SoundscapeDriver,
  type Speaker,
  type Voice,
  type VoicePlay,
  type VoiceRole,
} from '../src/index.ts';
import { bundleFiles } from './fixtures.ts';

class FakeVoice implements Voice {
  readonly plays: VoicePlay[] = [];
  readonly gains: number[] = [];
  stopped = false;
  paused = false;
  onEnded?: () => void;
  onDuration?: (ms: number) => void;
  constructor(
    readonly url: string,
    readonly role: VoiceRole,
  ) {}
  play(request: VoicePlay): void {
    this.plays.push(request);
  }
  setGain(gain: number): void {
    this.gains.push(gain);
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeSpeaker implements Speaker {
  readonly voices: FakeVoice[] = [];
  /** When set, a voice comes only when the test says. */
  hold = false;
  refuse = new Set<string>();
  readonly waiting: (() => void)[] = [];
  voice(url: URL, role: VoiceRole): Promise<Voice> {
    if (this.refuse.has(url.pathname)) return Promise.reject(new Error('no such file'));
    const voice = new FakeVoice(url.pathname, role);
    if (!this.hold) {
      this.voices.push(voice);
      return Promise.resolve(voice);
    }
    return new Promise((resolve) =>
      this.waiting.push(() => {
        this.voices.push(voice);
        resolve(voice);
      }),
    );
  }
}

// Every promise a voice's opening chains on, settled.
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

async function choir(
  mediaUrl: (path: string) => string | undefined = (path) => `https://cdn.test/${path}`,
) {
  return Campaign.fromFiles(bundleFiles('the-choir'), { python: false, mediaUrl });
}

const TAVERN = 0;
const RAIN = 1;

describe('the soundscape driver', () => {
  let speaker: FakeSpeaker;
  beforeEach(() => {
    vi.useFakeTimers();
    speaker = new FakeSpeaker();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const driverFor = (campaign: Campaign) =>
    new SoundscapeDriver(campaign, speaker, { now: () => Date.now() });

  test('opens a voice per track, ramps it in, and lets it go after a stop fades out', async () => {
    const campaign = await choir();
    const driver = driverFor(campaign);
    driver.apply({ kind: 'play', soundscape: campaign.soundscape(TAVERN), fadeInMs: 0 });
    await settle();
    expect(speaker.voices.map((voice) => [voice.url, voice.role])).toEqual([
      ['/media/music/tavern.ogg', 'track'],
    ]);
    const [tavern] = speaker.voices;
    expect(tavern!.plays[0]).toMatchObject({ from: 0, rate: 1 });
    expect(driver.playing).toBe(campaign.soundscape(TAVERN).id);

    // The track's own second-long fade-in, to its 0.8, written as it goes.
    vi.advanceTimersByTime(1_200);
    const peak = Math.max(...tavern!.gains);
    expect(peak).toBeCloseTo(0.8, 2);
    expect(tavern!.gains[0]).toBeLessThan(0.2);

    // Stopped: down over the soundscape's two-second fade-out, then let go.
    driver.apply({ kind: 'stop', fadeOutMs: 2_000 });
    vi.advanceTimersByTime(1_000);
    expect(tavern!.stopped).toBe(false);
    vi.advanceTimersByTime(1_500);
    expect(tavern!.stopped).toBe(true);
    expect(tavern!.gains.at(-1)).toBeLessThan(0.05);
    expect(driver.idle).toBe(true);
  });

  test('hands one soundscape to the next in turn, never both at once', async () => {
    const campaign = await choir();
    const driver = driverFor(campaign);
    driver.apply({ kind: 'play', soundscape: campaign.soundscape(TAVERN), fadeInMs: 0 });
    await settle();
    driver.apply({ kind: 'stop', fadeOutMs: 2_000 });
    driver.apply({ kind: 'play', soundscape: campaign.soundscape(RAIN), fadeInMs: 0 });
    await settle();
    expect(speaker.voices.map((voice) => voice.url)).toEqual(['/media/music/tavern.ogg']);
    vi.advanceTimersByTime(2_500);
    await settle();
    expect(speaker.voices.map((voice) => voice.url)).toEqual([
      '/media/music/tavern.ogg',
      '/media/sfx/rain.ogg',
    ]);
    expect(speaker.voices[0]!.stopped).toBe(true);
    expect(driver.playing).toBe(campaign.soundscape(RAIN).id);
  });

  test('a voice that comes late joins where the clock is, not where it was asked', async () => {
    const campaign = await choir();
    const driver = driverFor(campaign);
    speaker.hold = true;
    driver.apply({ kind: 'play', soundscape: campaign.soundscape(TAVERN), fadeInMs: 0 });
    vi.advanceTimersByTime(150);
    speaker.waiting.shift()!();
    await settle();
    expect(speaker.voices[0]!.plays[0]!.from).toBe(150);
  });

  test('a looping clip that comes very late comes round inside its loop', async () => {
    const campaign = await choir();
    const driver = driverFor(campaign);
    speaker.hold = true;
    // Rain's ten-second clip as a gapless `auto` bed on a minute-long
    // timeline: the one shape the scheduler opens as a single looping voice,
    // where the fixture's own `looping` track is a fresh voice per pass.
    const rain = engineSoundscapes.get(campaign.soundscape(RAIN))!;
    const looped = toSoundscape({
      ...rain,
      length: 60_000n,
      tracks: rain.tracks.map((track) => ({ ...track, mode: 'auto' as const })),
    });
    driver.apply({ kind: 'play', soundscape: looped, fadeInMs: 0 });
    vi.advanceTimersByTime(12_500);
    speaker.waiting.shift()!();
    await settle();
    // Rain loops a ten-second clip: 12.5 s in is 2.5 s into its second turn.
    expect(speaker.voices[0]!.plays[0]).toMatchObject({
      from: 2_500,
      to: 10_000,
      looping: true,
      loopFrom: 0,
    });
  });

  test('gains the scheduler writes before a voice is ready reach it when it is', async () => {
    const campaign = await choir();
    const driver = driverFor(campaign);
    speaker.hold = true;
    driver.apply({ kind: 'play', soundscape: campaign.soundscape(TAVERN), fadeInMs: 0 });
    vi.advanceTimersByTime(500);
    speaker.waiting.shift()!();
    await settle();
    const [tavern] = speaker.voices;
    expect(tavern!.gains.at(-1)).toBeGreaterThan(0.3);
  });

  test('a track with no file, and one that will not play, are silence and nothing worse', async () => {
    const missing = await choir((path) =>
      path.includes('tavern') ? undefined : `https://cdn.test/${path}`,
    );
    const driver = driverFor(missing);
    driver.apply({ kind: 'play', soundscape: missing.soundscape(TAVERN), fadeInMs: 0 });
    await settle();
    vi.advanceTimersByTime(200);
    expect(speaker.voices).toEqual([]);

    const refused = await choir();
    speaker.refuse.add('/media/sfx/rain.ogg');
    const other = driverFor(refused);
    other.apply({ kind: 'play', soundscape: refused.soundscape(RAIN), fadeInMs: 0 });
    await settle();
    vi.advanceTimersByTime(200);
    expect(speaker.voices).toEqual([]);
  });

  test("a file's length, once known, is what a bed to its end turns on", async () => {
    const campaign = await choir();
    const driver = driverFor(campaign);
    driver.apply({ kind: 'play', soundscape: campaign.soundscape(TAVERN), fadeInMs: 0 });
    await settle();
    const [tavern] = speaker.voices;
    expect(tavern!.plays[0]!.to).toBeUndefined();
    tavern!.onDuration?.(3_000);
    // An `auto` bed that ran to its end is given its file again, gaplessly,
    // on the same voice.
    vi.advanceTimersByTime(3_000);
    tavern!.onEnded?.();
    await settle();
    expect(speaker.voices).toHaveLength(1);
    expect(tavern!.plays.length).toBeGreaterThanOrEqual(2);
    expect(tavern!.plays.at(-1)!.from).toBe(0);
  });

  test('mute writes silence at once, and unmuting brings the gain straight back', async () => {
    const campaign = await choir();
    const driver = driverFor(campaign);
    driver.apply({ kind: 'play', soundscape: campaign.soundscape(TAVERN), fadeInMs: 0 });
    await settle();
    vi.advanceTimersByTime(1_500);
    const [tavern] = speaker.voices;
    driver.setMuted(true);
    expect(tavern!.gains.at(-1)).toBe(0);
    driver.setMuted(false);
    expect(tavern!.gains.at(-1)).toBeCloseTo(0.8, 2);
  });

  test('pausing holds every voice and the clock; resuming lets them go', async () => {
    const campaign = await choir();
    const driver = driverFor(campaign);
    driver.apply({ kind: 'play', soundscape: campaign.soundscape(TAVERN), fadeInMs: 0 });
    await settle();
    const [tavern] = speaker.voices;
    driver.pause();
    expect(tavern!.paused).toBe(true);
    const written = tavern!.gains.length;
    vi.advanceTimersByTime(1_000);
    expect(tavern!.gains.length).toBe(written);
    driver.resume();
    expect(tavern!.paused).toBe(false);
  });

  test('a cue opens a voice of its own, beside the soundscape', async () => {
    const campaign = await choir();
    const driver = driverFor(campaign);
    driver.apply({ kind: 'cue', media: 2, url: campaign.mediaUrl(2)!, volume: 0.5, speed: 1 });
    await settle();
    expect(speaker.voices.map((voice) => [voice.url, voice.role])).toEqual([
      ['/media/sfx/door.ogg', 'cue'],
    ]);
  });

  test('a soundscape that is a copy of the one handed out is refused, not played as silence', async () => {
    const campaign = await choir();
    const driver = driverFor(campaign);
    const copy = structuredClone(campaign.soundscape(TAVERN));
    expect(() => driver.apply({ kind: 'play', soundscape: copy, fadeInMs: 0 })).toThrow(
      RippleError,
    );
    await settle();
    expect(speaker.voices).toHaveLength(0);
  });

  test("a Player hands the story's sound to its driver", async () => {
    const campaign = await choir();
    const audio = driverFor(campaign);
    const player = new Player(campaign.session({ seed: 0 }), { onEffect: () => {}, audio });
    player.start();
    await settle();
    expect(audio.playing).toBe(campaign.soundscape(TAVERN).id);
    expect(speaker.voices).toHaveLength(1);
    player.stop();
    vi.advanceTimersByTime(3_000);
    expect(speaker.voices[0]!.stopped).toBe(true);
  });
});
