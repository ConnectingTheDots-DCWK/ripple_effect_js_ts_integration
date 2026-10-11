// The page the speaker's browser pass opens. Real voices in a real context,
// over WAV files the page writes itself, so nothing is fetched but itself.
// The runner clicks *Begin* first: no browser lets a page make a sound before
// a gesture, which is exactly the rule `unlock()` exists for.
import { WebAudioSpeaker } from '../../src/index.ts';

declare global {
  interface Window {
    results: Promise<Record<string, unknown>>;
  }
}

function wav(seconds: number, hz: number): URL {
  const rate = 22_050;
  const frames = Math.round(seconds * rate);
  const data = new DataView(new ArrayBuffer(44 + frames * 2));
  const text = (at: number, value: string) => {
    for (const [i, c] of [...value].entries()) data.setUint8(at + i, c.charCodeAt(0));
  };
  text(0, 'RIFF');
  data.setUint32(4, 36 + frames * 2, true);
  text(8, 'WAVEfmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, rate, true);
  data.setUint32(28, rate * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  text(36, 'data');
  data.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i += 1)
    data.setInt16(44 + i * 2, Math.sin((i / rate) * hz * 2 * Math.PI) * 8_000, true);
  return new URL(URL.createObjectURL(new Blob([data.buffer], { type: 'audio/wav' })));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const play = { from: 0, gain: 1, rate: 1, looping: false, loopFrom: 0 };

// How long until `onEnded`, or `null` if it did not come within `wait`.
async function ending(
  voice: { onEnded?: () => void },
  start: () => void,
  wait: number,
): Promise<number | null> {
  const began = performance.now();
  const ended = new Promise<number>((resolve) => {
    voice.onEnded = () => resolve(performance.now() - began);
  });
  start();
  return Promise.race([ended, sleep(wait).then(() => null)]);
}

window.results = new Promise((resolve) => {
  document.querySelector('#begin')!.addEventListener('click', async () => {
    const speaker = new WebAudioSpeaker();
    await speaker.unlock();
    const second = wav(1, 440);
    const half = wav(0.5, 660);
    const out: Record<string, unknown> = { state: speaker.context.state };
    try {
      const track = await speaker.voice(second, 'track');
      const durations: number[] = [];
      track.onDuration = (ms: number) => durations.push(ms);
      out.trackEnded = await ending(track, () => track.play(play), 3_000);
      out.trackDuration = durations[0] ?? null;

      const clipped = await speaker.voice(second, 'track');
      out.clippedEnded = await ending(clipped, () => clipped.play({ ...play, to: 300 }), 3_000);

      const looped = await speaker.voice(second, 'track');
      out.loopEnded = await ending(
        looped,
        () => looped.play({ ...play, to: 400, looping: true, loopFrom: 100 }),
        1_500,
      );
      looped.stop();

      const cue = await speaker.voice(half, 'cue');
      const cueDurations: number[] = [];
      cue.onDuration = (ms: number) => cueDurations.push(ms);
      out.cueEnded = await ending(cue, () => cue.play(play), 3_000);
      out.cueDuration = cueDurations[0] ?? null;

      const held = await speaker.voice(half, 'cue');
      out.heldEnded = await ending(
        held,
        () => {
          held.play(play);
          setTimeout(() => held.pause(), 200);
          setTimeout(() => held.resume(), 700);
        },
        3_000,
      );

      const silenced = await speaker.voice(half, 'cue');
      out.stoppedEnded = await ending(
        silenced,
        () => {
          silenced.play(play);
          setTimeout(() => silenced.stop(), 100);
        },
        1_200,
      );
    } catch (error) {
      out.error = (error as Error).message;
    }
    resolve(out);
  });
});
