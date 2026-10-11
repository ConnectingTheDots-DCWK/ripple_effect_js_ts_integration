# ripple_effect_js_ts_integration

The JavaScript and TypeScript bindings of the Ripple Effect engine: npm
packages under `packages/`, each carrying the engine as WebAssembly components
transpiled by jco. **The engine is not built here.** It is released from the
private `ripple_effect` repository as `engine-v<version>` in the public
`ripple_engine_releases`, and this repository pins one (`engine.json`). Why it
is shaped as it is lives in that repository, as ADR
*a-campaign-plays-in-a-page* and `docs/internals/integrating-a-host.md` §12.
Neither is repeated here.

| | |
| --- | --- |
| `packages/player` | `@ripplefx/player`: `Campaign`, `Session`, `Player`, the effects, the values. Mandatory. |
| `packages/soundscape` | `@ripplefx/soundscape`: the Web Audio speaker. Optional, deferred, not yet written. |
| `engine.json` | The pin: the engine version, and the digests of both component archives and of the conformance fixtures. |
| `engine-signing.pub` | The key the manifest's signature is checked against, a copy of `packages/ripple_native/native/engine-signing.pub` there. |
| `scripts/engine.ts` | `pnpm engine`: download, verify, unpack into `engine/`. |

## Environment

Node ≥ 22.18, which runs `.ts` scripts without a build step, and pnpm 11 via
`packageManager`. `pnpm install`, then **`pnpm engine` before anything
else**: typecheck, tests and the build all read `engine/` and the
`generated/` made from it, and none of that is committed. Until
`engine.json` pins a published release, `RIPPLE_ENGINE_TREE=<a ripple_effect
checkout> pnpm engine` takes what that checkout's `melos run wasm:build`
made, and writes `engine/UNVERIFIED` to say so.

## Verifying a change

```sh
pnpm check                                   # biome, typecheck, the Node suites
pnpm --filter @ripplefx/player browsers      # Chromium, Firefox, WebKit via Vite
```

The Node suite plays every conformance fixture of the pinned release through
`Session` and through `Player`, in both variants: 23 with Python, and 20 without,
skipping 3. `test/driver.ts` is the driver, written from the release's
`FORMAT.md` and touching no file, so the browser pass runs the same code in a
page. **A test has to be able to fail.** The suite was seen red three ways
before it was trusted: a passage's title in place of its text (88 failures),
a hold one millisecond long (6), an Int as a JavaScript number (14).

## The decisions

- **One instance per campaign, one compile per page.** `Engine.load`
  instantiates afresh, and the compiled `WebAssembly.Module`s are cached by
  URL. A trap ruins an instance, and this way it ruins one campaign.
- **Every engine call goes through `Engine.call`.** That is where a
  `WebAssembly.RuntimeError` becomes `EngineTrap` and poisons the instance,
  and where a WIT `result`'s error becomes the class that names it. A new
  verb that returns a `result` passes its mapping as the second argument, or
  jco's bare `ComponentError` reaches the host. `soundscape`, `board` and
  `Session.create` were found doing exactly that.
- **The variant follows the bundle**, read from `campaign.json` before any
  engine exists. `needs` decides when it is there. From bundle format 15 an
  absent `needs` means none. **Below 15 it means "cannot say", and the
  interpreter is loaded**: the conformance fixtures are formats 2–6, and three
  of them run scripts without saying so.
- **Ints are `bigint`, Floats are `number`**, in both directions. A plain
  object is accepted as a map when writing, and a `Map` is what comes back.

## Traps

- **jco's glue carries its own core-module loader**, as `new URL(`./${name}`,
  import.meta.url)`, for a caller that passes no `getCoreModule`. A bundler
  reading that template globs the directory: Vite copied `engine.d.ts` into a
  page's assets. `scripts/transpile.ts` replaces it with a refusal, and
  **fails if jco's output stops containing it exactly once**, which is what a
  jco upgrade should be met with.
- **`--no-nodejs-compat` is needed with `--instantiation async`.** Without it
  the glue keeps an `import('node:fs/promises')` that a browser bundler trips
  on, in a branch that mode never takes.
- **A `ComponentError` is known by its own `payload` property**, not its name
  (jco sets none) and not its class (a minifier renames it).
- **A browser's `JSON.parse` cannot be relied on to say whether `7` was
  `7.0`.** The Node suite reads fixtures with a reviver over the number's
  source text. The browser pass sends Ints across as `{"$int": "7"}`.
- **`node scripts/x.ts` cannot import `src/`**, whose specifiers are `.js` as
  the TypeScript build wants. A script under plain Node imports only files
  that import nothing from `src/`, which is why `test/canonical.ts` exists.
- **`generated/` is under the Runtime Licence and is never committed.** It is
  built from the verified release and shipped only inside a package, beside
  `ENGINE-NOTICE`.

## What is deliberately not here

- **A Worker transport.** Every verb is synchronous on the caller's thread, so
  a host keeps one queue in call order. A Worker would make every verb a
  promise. It is a later minor version, when a campaign needs one.
- **Markdown rendering.** A page picks its renderer, and its sanitiser.
- **A re-test of the engine's rules.** The fixtures test the spelling; the
  rules are tested where they run.

## Releasing

A package's version is the contract's `MAJOR.MINOR` and its own `PATCH`.
- Pin the release in `engine.json`: the version, `keyId`, and the three
  digests from its signed manifest.
- Run `pnpm engine` (it refuses a mismatch), then `pnpm check` and the
  browser pass.
- Move the `CHANGELOG.md` section, then dispatch **Publish** with
  `createRelease`. It tags `v<version>`, creates the GitHub release and
  publishes with npm's trusted publishing.
- **Check the archive, not the dry run.** Run `npm pack` and read the file
  list: `dist/`, `generated/<both>/`, `ENGINE-NOTICE`, `LICENSE`.
