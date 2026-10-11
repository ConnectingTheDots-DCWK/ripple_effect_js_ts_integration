# @ripplefx/player

Play [Ripple Effect](https://ripplefx.app) campaigns in a browser, or in Node.
The engine that plays them, the same one the editor runs, is inside the
package as a WebAssembly component. This package is the TypeScript API over
it.

```sh
npm install @ripplefx/player
```

```ts
import { Campaign, Player, resolveLink } from '@ripplefx/player';

// A campaign exported from the editor (Export → Campaign), served as a folder.
const campaign = await Campaign.load('/campaigns/the-city-of-elsenmar/');

const player = new Player(campaign.session({ seed: Date.now() }), {
  onEffect(effect) {
    switch (effect.kind) {
      case 'show': // a passage: render effect.passage.text, offer its choices
        break;
      case 'ask': // a prompt: effect.prompt.fields
        break;
      case 'ended':
        break;
      // …and 'audio', 'ambience', 'changed', 'jumped', 'callback', 'failed'
    }
  },
});
player.start();
// later, when the reader picks the second choice:
player.choose(1);
```

## What it does, and what it leaves to you

- **It plays the story**: every rule of a campaign runs in the engine. You get
  an ordered list of *effects* for each thing the reader does, and the last
  one says where the story is now: a passage, a prompt, a wait or an ending.
- **It loads what it needs.** `Campaign.load` fetches `campaign.json` and the
  documents it names, and loads the engine **with Python only when the
  campaign uses it** (its `needs`): about 1.36 MB over the wire with Python,
  0.31 MB without.
- **It does not draw.** A passage's `text` is Markdown, or HTML for a campaign
  exported that way. Render it with the library you like and **sanitise
  what it produces**. Pictures keep the author's own links;
  `resolveLink(passage, src)` turns one into the file's URL, so hand it to
  your renderer's image hook.
- **It does not play sound.** The `audio` effects say what a speaker should
  do. A Web Audio speaker, `@ripplefx/soundscape`, is coming; any other can be
  written against the same contract.

## The API in one screen

| | |
| --- | --- |
| `Campaign.load(url, options?)` | Open a bundle served as a folder. `options.python`: `'auto'` (default), `true` or `false`. |
| `Campaign.fromFiles(files, options?)` | Open one you already hold, as a map of path to text or bytes. |
| `campaign.session(start?)` | A `Session`: `seed`, `locale`, `board`, budgets. |
| `Session.resume(campaign, save, start?)` | Pick up a save that `pause()` or `checkpoint()` wrote. |
| `session.start() / choose(i) / answer(values) / elapsed() / setLocale(l) / restart() / pause() / stop()` | The verbs. Each returns `Effect[]` and runs synchronously. |
| `new Player(session, { onEffect })` | The loop over a session: delivers every effect and waits out a `hold` for you. |
| `campaign.mediaUrl(i)`, `campaign.coverUrl` | Where a picture or a sound is. |

**Numbers.** Times and indices are JavaScript numbers. A story's **Int is a
`bigint`** and its Float a `number`, so `7n` and `7` are different values, as
they are to the engine. Maps keep their order as `Map`s.

**Errors** are classes: `BundleError` (the bundle won't open), `HostError` (a
verb out of turn, which is a bug in the host), `ResumeError`, `NeedsPython`,
`LoadError` and `EngineTrap`. A trap means the engine panicked: that campaign
is unusable from then on, so load it again and resume your last save.

## Notes for a page

- The engine runs **on the calling thread**. A passage takes microseconds; a
  Script node runs under its deadline, and the page doesn't paint while it
  does.
- Serve `.wasm` as `application/wasm`, so it compiles while it downloads.
  Anything else still works, just later. No `COOP`/`COEP` headers are needed.
- Browsers start no audio before the reader's first click, so put a *Begin*
  button in front of the story.
- Bundlers find the engine's files on their own: Vite, webpack 5, esbuild and
  Astro all follow `new URL(…, import.meta.url)`. To serve them from
  elsewhere, pass `wasmBase`.

## Licence

The package's code is MIT. **The engine inside it is not**: it is © 2026
ConnectingTheDots, under the [Ripple Effect Runtime
Licence](https://ripplefx.app/go/runtime-licence). That licence lets you ship
it, unmodified in function, as part of your own product, free of charge.
Reproduce `ENGINE-NOTICE` wherever your product lists the third-party software
it uses. See `LICENSE`.
