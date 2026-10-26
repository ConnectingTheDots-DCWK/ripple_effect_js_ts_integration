# The speaker contract

How a campaign's soundscapes reach a speaker, for anybody writing one: a game
engine's audio, Howler, a native bridge, or a page that wants to play them
its own way. `@ripplefx/soundscape` is one implementation; this is what any
other has to do. It binds **Ripple Effect contract 1.6**, unchanged here since
1.5, and transcribes the engine's `host-audio-system.md` §9, the source of
truth, in its terms here.

## Three layers, and the one you write

1. **The session** says what the story asks for, as `audio` effects: `play`
   a soundscape, `stop` it, `cut` everything, `cue` a sound.
2. **The scheduler** decides every voice from those: which file, from where,
   how loud, when it fades, when one soundscape hands over to the next. It
   is the engine's `mixer`, with no clock, no file and no voice of its own.
   `SoundscapeDriver` in `@ripplefx/player` drives it: it ticks it every
   25 ms while anything sounds, and does every duty the scheduler asks of a
   host.
3. **The speaker** makes sounds. It is the only part that touches an audio
   API, and the only part this document asks you to write.

```ts
import { SoundscapeDriver, Player } from '@ripplefx/player';

const audio = new SoundscapeDriver(campaign, mySpeaker);
const player = new Player(session, { onEffect, audio });
```

## The interface

```ts
interface Speaker {
  voice(url: URL, role: 'track' | 'cue'): Promise<Voice>;
}

interface Voice {
  play(request: VoicePlay): void;
  setGain(gain: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
  onEnded?: () => void;              // set by the driver
  onDuration?: (ms: number) => void; // set by the driver
}

interface VoicePlay {
  from: number;      // ms into the file
  to?: number;       // ms into the file; the file's end when absent
  gain: number;      // 0–1, on the engine's gain scale (below)
  rate: number;      // 1 is as recorded
  looping: boolean;
  loopFrom: number;  // ms: where each turn of a loop comes round to
}
```

## What each part must do

- **`voice(url, role)`** resolves once the voice can begin *at once*. Load
  the file, or enough of it. It **rejects** when the file cannot be played,
  and the driver tells the scheduler, which hears that as silence and never
  retries. A `track` may be minutes long; a `cue` is a short sound effect
  that must start on time. The role is a hint about which strategy to use,
  not a different contract.
- **`play(request)`** begins at once and replaces whatever the voice was
  playing.
  - It may be called again on the same voice. That is a gapless bed whose
    file ended coming round again, and the driver expects the new play to
    follow on as closely as the API allows.
  - It plays from `from` to `to`, or to the end of the file. When `looping`
    is set, reaching `to` comes round to **`loopFrom`, not `from`**: a bed
    joined partway in loops over its whole clip.
- **`onEnded`** fires once per play, when a non-looping voice reaches the end
  of what it was given. It never fires after `stop()`, and never for a
  looping voice.
- **`onDuration(ms)`** fires once, when the file's length is known. A track
  played to the end of its file has no end the scheduler can plan a fade-out
  or a gapless turn for until then.
- **`setGain`** writes a new gain. The scheduler writes one every tick a fade
  moves, a step at a time, so smooth between them over a few milliseconds,
  or a fade is a staircase.
- **`pause` and `resume`** hold a voice exactly where it is and let it go
  again. The driver pauses every voice together.
- **`stop`** ends the voice for good and lets its resources go.

**The gain scale is cubic** (`host-audio-system.md` §9 in the engine's
repository). The editor writes a gain to mpv's volume control, whose curve
is cubic, so a speaker writing amplitude writes
**`gain ** 3`**: half the gain is an eighth of the amplitude. A speaker that
writes the gain as amplitude mixes every soundscape louder in its quiet parts
than its author heard it.

## What the driver does, so the speaker does not

All of this lives in `SoundscapeDriver` and must not be repeated in a
speaker:
- the timer;
- the scheduler's commands;
- **a late voice**: the time `voice()` took, times `rate`, is added to
  `from`, and a looping clip wraps inside its loop. A clip already over
  plays nothing;
- gains written before a voice was ready, applied when it is;
- tracks whose file has no URL, told to the scheduler rather than tried;
- mute, which is the scheduler's: it writes zero and remembers;
- the handover between soundscapes, which never overlap.

## Proving a speaker

`packages/soundscape/test/browser/run.ts` is the check `@ripplefx/soundscape`
passes in Chromium, Firefox and WebKit:
- a file ends near its length, and reports it;
- a clip ends near its `to`;
- a loop never ends;
- a cue ends near its length;
- a paused cue ends later by the pause;
- a stopped voice never ends.

A speaker of your own should pass the same shape. Hear it too, with
`examples/player` over a real campaign: a test can count voices, but only a
person can hear a seam.
