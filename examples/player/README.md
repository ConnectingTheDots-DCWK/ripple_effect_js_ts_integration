# A campaign in a page

The packages as a page uses them: a campaign opened from a folder, its
passages drawn with their pictures, its soundscapes played through the Web
Audio speaker, a language switch, mute, restart, and 1–9 for the choices. It
is where a developer starts from, and the **listening pass** for the
soundscape speaker, because a test can count voices but only a person can
hear a seam.

Everything is run from the repository root, not from this folder: the page
imports `@ripplefx/player` and `@ripplefx/soundscape` as built packages, and
their `dist/` and the engine's `generated/` are made there and never
committed. Skipping that is an import error for `@ripplefx/player`.

```sh
pnpm install
pnpm engine                        # or, until engine.json pins a release:
RIPPLE_ENGINE_TREE=<a ripple_effect checkout> pnpm engine
pnpm build
RIPPLE_CAMPAIGNS=<a folder of compiled bundles> pnpm --filter @ripplefx/example-player dev
```

`pnpm engine` refuses while `engine.json` pins no published release. Until
then `RIPPLE_ENGINE_TREE` takes the components a checkout of the engine built
with `fvm dart run melos run wasm:build`, from its `target/wasm/`. Run
`pnpm engine` and `pnpm build` again after the engine or the packages change;
an edit to the example itself is picked up by the dev server.

A bundle is what the editor's **Export → Campaign** writes, or the engine's
`compile` binary. In the engine's repository, `melos run campaign:compile`
leaves *The City of Elsenmar* in `build/campaign/`, so pointing
`RIPPLE_CAMPAIGNS` there plays it. Each folder is served at `/<its name>/`, as
`demo.ripplefx.app` will serve it.

`node e2e.mjs [chromium|firefox|webkit]` plays the first campaign by its
first choices, three seconds a passage, and prints what it saw: every
picture's size, every audio file requested, and whether the speaker's context
ran. It expects the dev server on port 5179, which is not Vite's default
(5173, or the next one free), so start it with `dev --port 5179`.
