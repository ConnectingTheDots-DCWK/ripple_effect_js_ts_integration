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
| `packages/soundscape` | `@ripplefx/soundscape`: the Web Audio speaker, plain MIT because it carries no engine. Optional: `docs/speaker.md` is the contract another speaker implements. |
| `examples/player` | A campaign in a page, the packages used as a page uses them, over any folder of compiled bundles (`RIPPLE_CAMPAIGNS`). The listening pass, and the demo site's starting point. |
| `docs/speaker.md` | The public speaker contract, transcribed from the engine's `host-audio-system.md` §9. |
| `engine.json` | The pin: the engine version, and the digests of both component archives and of the conformance fixtures. |
| `engine-signing.pub` | The key the manifest's signature is checked against, a copy of `packages/ripple_native/native/engine-signing.pub` there. |
| `scripts/engine.ts` | `pnpm engine`: download, verify, unpack into `engine/`. |

## Environment

Node at `mise.toml`'s version — at or above `engines`' 22.18, the first that
runs `.ts` scripts without a build step — and pnpm at `packageManager`'s.
`mise install` puts Node and the hooks' tools on a machine, `mise run doctor`
(`scripts/doctor.sh`) checks all of it, pnpm and Playwright's browsers
included, and CI installs Node with `jdx/mise-action` from the same file. `pnpm install`, then **`pnpm engine` before anything
else**: typecheck, tests and the build all read `engine/` and the
`generated/` made from it, and none of that is committed. To play an
unreleased engine, `RIPPLE_ENGINE_TREE=<a ripple_effect checkout> pnpm
engine` takes what that checkout's `melos run wasm:build`
made, and writes `engine/UNVERIFIED` to say so.

## Verifying a change

```sh
pnpm check                                       # biome, typecheck, the Node suites
pnpm --filter @ripplefx/player browsers          # every fixture in Chromium, Firefox, WebKit
pnpm --filter @ripplefx/soundscape browsers      # real voices in the same three
RIPPLE_CAMPAIGNS=… pnpm --filter @ripplefx/example-player dev   # and listen
```

The Node suite plays every conformance fixture of the pinned release through
`Session` and through `Player`, in both variants: 33 with Python, and 27 without,
skipping 6. `test/driver.ts` is the driver, written from the release's
`FORMAT.md` and touching no file, so the browser pass runs the same code in a
page. **A test has to be able to fail.** The suite was seen red three ways
before it was trusted: a passage's title in place of its text (88 failures),
a hold one millisecond long (6), an Int as a JavaScript number (14).

**The soundscape driver is tested against a speaker that writes down what
it is told**, on a clock that is a number (`test/soundscape.test.ts`). It was
seen red three ways: no latency added to a late voice, no wrap inside a loop,
gains before a voice was ready dropped. The speaker itself is tested only in
browsers, which is the only place Web Audio exists, and **heard** in the
example: every check there passing says nothing about a seam in a loop.

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
- **A callback's handler table is the `Player`'s, host-side**, as
  `campaign-host-api.md` §5b puts it: the engine emits a name, and the
  lookup, the miss count and the absorbing of a throwing handler are here.
  It is the JS spelling of the designed `ripple_session_on_callback`. A
  handler runs in place rather than queued, so §5b rule 4 holds for it: a
  callback about a passage arrives before the passage. That is also why a
  verb from inside any handler throws `ReentrantVerb`: the rest of the
  batch would otherwise arrive after the new one.
- **A handler's error never cuts a batch short.** `onEffect`, a callback
  handler or the sound throwing goes to `onError` (or `reportError`), and
  delivery goes on. The Dart binding doesn't do this yet; the spec asks for
  it.
- **The `Player` is the host's clock three times over**: for a `hold`, for
  a passage's countdown, and for the instant a story reads. It waits a
  countdown's `afterMs`, says `beginCountdown`, waits `timeoutMs`, says
  `expire`, and drops both waits when the story moves; `countdowns: false`
  hands that to the host, and the fixture driver sets it, because a clock
  that does not wait would only ever take the default (ADR
  *a-countdown-is-the-hosts*). It stamps `setNow` before every verb **only
  once `dateTime` was granted through its own `permit`**, as the Dart
  binding does; a grant made on `player.session` goes round it.
- **`setLocale` and `permit` move nothing, so they cancel nothing.** Every
  other verb drops a pending hold and countdown first. A change of language
  during a wait answers no effects, so cancelling the hold there stranded
  the story for good, which 1.5.0 shipped.
- **Ints are `bigint`, Floats are `number`**, in both directions. A plain
  object is accepted as a map when writing, and a `Map` is what comes back.

- **The driver is the host's half of the scheduler, and a speaker is only
  the sound.** `SoundscapeDriver`, in the player, does every duty
  `host-audio-system.md` §9 gives a host, ported from the editor's
  `SoundscapeMixer`. That is the timer, a late voice's `from`, a loop's wrap,
  pending gains, unresolved tracks and routing a voice's end and length
  back. A `Speaker` opens a file and obeys. A new duty goes in the driver,
  or every speaker has to learn it.
- **A gain is the editor's level, and amplitude is its cube.** The editor
  writes a gain to mpv's volume, whose curve is cubic. The engine's
  `host-audio-system.md` §9 says so, and `docs/speaker.md` repeats it.
- **A track streams, a cue is a buffer.** Decoding Elsenmar's music beds
  would take about 0.75 GB, while a cue that starts late is the one lateness
  anyone hears.

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
- **jco spells a WIT enum's members with dashes**: `cvar-changed`,
  `date-time`. A value a host matches on by the spec's name is mapped back
  through a table, as `CALLBACK_EVENTS` and `PERMISSION_KINDS` in
  `effects.ts` do. The callback event shipped spelled the WIT way until the
  fixtures' `callbacks` list compared it. A host-facing enum the world only
  passes through — `TurnKind`, `Verb` in a `wrong-turn` — keeps the world's
  spelling.
- **The 1.6 `FORMAT.md` does not describe what 1.6 added to a fixture**:
  `input.json`'s `now`, `permit` and `standIns`, the `countdown`, `expire`
  and `permit` moves, a passage's `timer` and the `permit` and `notice`
  events. The driver follows the engine's runner,
  `crates/ripple-runtime/src/conformance/`, instead: `now` is read at its
  own offset, a stand-in typed without one at UTC, the host's answers are
  told before `start` and again after every resume, and the reader leaving
  stops at a `permit` turn.
- **A `ComponentError` is known by its own `payload` property**, not its name
  (jco sets none) and not its class (a minifier renames it).
- **A browser's `JSON.parse` cannot be relied on to say whether `7` was
  `7.0`.** The Node suite reads fixtures with a reviver over the number's
  source text. The browser pass sends Ints across as `{"$int": "7"}`.
- **`node scripts/x.ts` cannot import `src/`**, whose specifiers are `.js` as
  the TypeScript build wants. A script under plain Node imports only files
  that import nothing from `src/`, which is why `test/canonical.ts` exists.
- **WebKitGTK stalls a media element routed into Web Audio before it
  plays**: it sits at time 0, silently, for ever. It also never fires
  `ended` for one that is routed. So `TrackVoice` routes in `play()`'s
  resolution, muted until then, and watches for the file's end as well as
  listening for it. Chromium and Firefox needed neither. Real Safari is
  unproven on this until someone plays the example on a Mac and an iPhone.
- **The scheduler opens a `looping` track as a fresh voice per pass.** Only
  a gapless `auto` bed with a known clip end is one looping voice. A test of
  the loop arithmetic needs that shape, not the fixture's own.
- **A handover waits for the fade-out.** Elsenmar's gates soundscape fades
  over five seconds before tavern starts. A check that moves on every half
  second never hears tavern at all, which looks like a bug and is the spec.
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
- Head the package's `CHANGELOG.md` section `## <version>`, then dispatch
  **publish** on `main`, naming the package. It refuses a version already
  tagged, a version with no section and an unverified engine; tags
  `<package>-v<version>`, creates the GitHub release from that section and
  publishes with npm's trusted publishing and provenance. `player` goes
  first: `soundscape` peers on it.
- **A package's first version is published by hand**, because npm's
  trusted-publisher page exists only for a package that does: `npm publish
  --access public` from the packed archive, then the package's Settings →
  Trusted publishing → GitHub Actions, this repository, `publish.yml`. Every
  later version goes through the workflow and no token is stored.
- **Check the archive, not the dry run.** Run `npm pack` and read the file
  list: `dist/`, `generated/<both>/`, `ENGINE-NOTICE`, `LICENSE`.
