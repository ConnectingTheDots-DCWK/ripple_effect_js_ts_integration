# @ripplefx/soundscape

The Web Audio speaker for [`@ripplefx/player`](../player): a Ripple Effect
campaign's soundscapes, and the sounds its story cues, played in a browser.

```sh
npm install @ripplefx/player @ripplefx/soundscape
```

```ts
import { Campaign, Player, SoundscapeDriver } from '@ripplefx/player';
import { WebAudioSpeaker } from '@ripplefx/soundscape';

const campaign = await Campaign.load('/campaigns/the-city-of-elsenmar/');
const speaker = new WebAudioSpeaker();
const audio = new SoundscapeDriver(campaign, speaker);
const player = new Player(campaign.session({ seed: Date.now() }), { onEffect: draw, audio });

// No browser makes a sound before the reader's first click or key.
begin.addEventListener('click', async () => {
  await speaker.unlock();
  player.start();
});
```

The driver and the engine's scheduler decide every voice, gain and handover.
This package only makes the sounds:
- **A track streams** through a media element into a gain node. A music bed
  decoded whole would take about 23 MB a minute; one example campaign would
  take most of a gigabyte.
- **A cue is decoded** once, cached, and started from its buffer, so a sound
  effect is never late.
- **Every gain goes through Web Audio**, on the engine's cubic gain scale. It
  never uses `HTMLMediaElement.volume`, which iOS ignores.

`audio.setMuted(true)` mutes, `audio.pause()` holds everything (a hidden tab,
say) and `audio.dispose()` lets it all go. A file on another origin needs that
origin's CORS headers, or Web Audio hears it as silence.

The contract it implements is [`docs/speaker.md`](../../docs/speaker.md). A
page that would rather play sound its own way implements that instead, and
needs only `@ripplefx/player`.

MIT. See `LICENSE`.
