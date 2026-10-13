# Ripple Effect — JavaScript and TypeScript bindings

Play campaigns made with [Ripple Effect](https://ripplefx.app) in a browser,
or in Node.

| Package | What it is |
| --- | --- |
| [`@ripplefx/player`](packages/player) | **The campaign player**: the engine, as a WebAssembly component, and the TypeScript API over it. |
| [`@ripplefx/soundscape`](packages/soundscape) | The Web Audio speaker for a campaign's soundscapes. Optional: a page may bring its own speaker, written against [`docs/speaker.md`](docs/speaker.md). |
| [`examples/player`](examples/player) | A campaign in a page, pictures and sound included, over any folder of compiled bundles. |

The engine is built and released on its own, as `engine-v<version>` in
[`ripple_engine_releases`](https://github.com/ConnectingTheDots-DCWK/ripple_engine_releases).
These packages carry the release `engine.json` pins, verified against its
signed manifest when they are built. A package's `MAJOR.MINOR` is the
Ripple Effect contract it binds.

## Working on it

```sh
pnpm install
pnpm engine     # the pinned engine into engine/, verified
pnpm check      # biome, typecheck, the conformance suite in Node
pnpm --filter @ripplefx/player browsers   # …and in Chromium, Firefox, WebKit
```

To play an unreleased engine, `RIPPLE_ENGINE_TREE=<a ripple_effect checkout>
pnpm engine` takes the components that checkout built with `melos run
wasm:build`, unverified.

## Licence

The bindings are MIT. The engine the packages carry is under the Ripple Effect
Runtime Licence. See [`LICENSE`](LICENSE).
