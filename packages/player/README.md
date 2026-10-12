# @ripplefx/player

Play [Ripple Effect](https://ripplefx.app) campaigns in a browser, or in Node.
The engine that plays them, the same one the editor runs, is inside the
package as a WebAssembly component. This package is the TypeScript API over
it.

```sh
npm install @ripplefx/player
```

The package's code is MIT; **the engine inside it is under the Runtime
Licence**, free to ship as part of your product (see [Licence](#licence)).

```ts
import { Campaign, HostError, Player } from '@ripplefx/player';

// A campaign exported from the editor (Export → Campaign), served as a folder.
const campaign = await Campaign.load('/campaigns/the-city-of-elsenmar/');

const player = new Player(campaign.session({ seed: Date.now() }), {
  onEffect(effect) {
    switch (effect.kind) {
      case 'show': // a passage: render effect.passage.text, offer its choices
        break;
      case 'ask': // a prompt: effect.prompt.fields
        break;
      case 'ended': // the story is over, as the author wrote it
        break;
      case 'failed': // the story stopped on an error: effect.message, in English
        break;
      case 'stopped': // the session ended: after stop(), or pause()
        break;
      // …and 'hold', 'audio', 'ambience', 'changed', 'jumped', 'callback', 'trace'
    }
  },
  // Without this, a failure after a hold is an uncaught exception.
  onError: (error) => console.error(error),
});
player.start();

// Later, when the reader picks the second choice:
try {
  player.choose(1);
} catch (error) {
  // A choice drawn as unavailable (`available: false`) is refused if pressed.
  if (!(error instanceof HostError && error.failure.kind === 'choice-spent')) throw error;
}
```

For sound, give the `Player` a `SoundscapeDriver` as `audio` (below).

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
- **It schedules sound, and plays none.** `SoundscapeDriver` drives the
  engine's scheduler and hands each voice to a `Speaker`: give a `Player` one
  as `audio` and the story's sound follows the story.
  [`@ripplefx/soundscape`](../soundscape) is the Web Audio speaker; any other
  is written against [`docs/speaker.md`](../../docs/speaker.md).

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

## The API in one screen

| | |
| --- | --- |
| `Campaign.load(url, options?)` | Open a bundle served as a folder. Options: `python` — `'auto'` (default), `true` or `false`; `fetch`, passed to every request; `wasmBase`, where the engine's files are served. |
| `Campaign.fromFiles(files, options?)` | Open one you already hold, as a map of path to text or bytes. **Its media resolve only through `options.mediaUrl`**: without it no picture or sound has a URL. |
| `campaign.session(start?)` | A `Session`: `seed`, `locale`, `board`, budgets. Leave out `seed` and it is zero, and every reader rolls the same dice. |
| `Session.resume(campaign, save, start?)` | Pick up a save that `pause()` or `checkpoint()` wrote. |
| `session.start() / choose(i) / answer(values) / elapsed() / setLocale(l) / restart() / stop()` | The verbs. Each returns `Effect[]` and runs synchronously. `choose()` and `answer()` with nothing are the reader leaving. |
| `session.pause()`, `session.checkpoint()` | A save to resume from: `pause()` answers `{ save?, effects }` and ends the session, `checkpoint()` a `string` and goes on. Either has none unless the story is on a passage or a prompt. |
| `new Player(session, { onEffect, onError?, audio? })` | The loop over a session: delivers every effect and waits out a `hold` for you. Its own `pause()` answers the save. A verb called on `player.session` goes round it. |
| `player.onCallback(name, fn)`, `onAnyCallback(fn)`, `clearCallbacks()`, `callbackMisses` | The table for the author's named callbacks. |
| `session.cvars / entities / memory / guard` | The story's state, each a snapshot as of the last verb. |
| `session.consoleFeed(code)`, `player.consoleFeed(code)` | One line of Python against the live story, for a debugging console. |
| `campaign.asText(value)`, `coerceCvar`, `describeCvarRefusal` | The engine's own rules for printing and checking a value, off any session. |
| `campaign.mediaUrl(i)`, `campaign.coverUrl` | Where a picture or a sound is. |

**Numbers.** Times and indices are JavaScript numbers. A story's **Int is a
`bigint`** and its Float a `number`, so `7n` and `7` are different values, as
they are to the engine. Maps keep their order as `Map`s.

**Errors** are classes: `BundleError` (the bundle won't open), `HostError`,
`ResumeError`, `NeedsPython`, `LoadError` and `EngineTrap`. A `HostError` is a
verb the session refused, and nothing moved; `failure.kind` says why. Most
kinds are a bug in the host — a verb out of turn — but `choice-spent` (an
unavailable choice pressed) and `unknown-locale` (a language the campaign
lacks) are met in use and handled. A trap means the engine panicked: that
campaign is unusable from then on, so load it again and resume your last
save. Every message is English, for a log; branch on the fields.

## Named callbacks

An author can publish named points in the editor (*Callbacks*): `chapterTwo`
when a board is entered, `goldChanged` when a variable moves. A callback
carries no code. You register the handler against its name:

```ts
player.onCallback('chapterTwo', (fired) => game.unlock('chapter-2'));
```

- **It runs where the engine placed it**, inside the verb: a callback about
  a passage arrives before the passage does.
- **It must not call a verb on the player.** That throws `ReentrantVerb`.
  Schedule the verb with `queueMicrotask` instead.
- **A name nobody registered is not an error.** The story plays the same,
  and `callbackMisses` counts it.
- **A handler that throws doesn't stop the story.** The error goes to
  `onError`, or to the page's error reporting, and the rest of the batch
  still arrives. The same holds for `onEffect` itself.
- **A name is a published API.** It's the only thing joining the author's
  declaration to your code, so agree the names once.

The engine's rules are `campaign-host-api.md` §5b in the engine's repository.
Every callback also reaches `onEffect` as `{ kind: 'callback', event }`, for
a page that would rather switch than register.

## Licence

The package's code is MIT. **The engine inside it is not**: it is © 2026
ConnectingTheDots, under the [Ripple Effect Runtime
Licence](https://ripplefx.app/go/runtime-licence). That licence lets you ship
it, unmodified in function, as part of your own product, free of charge.
Reproduce `ENGINE-NOTICE` wherever your product lists the third-party software
it uses. See `LICENSE`.
