# Changelog

`MAJOR.MINOR` is the Ripple Effect contract this package binds; `PATCH` is the
package's own.

## Unreleased — 1.5.0

- **The first release.** The engine of contract 1.5, both variants, as
  WebAssembly components transpiled by jco 1.37.0 in async instantiation.
  `Campaign.load` serves a bundle as a folder, `Session` is the host API one
  to one, and `Player` is the loop over it with the clock for a `hold`.
- **`SoundscapeDriver` and the `Speaker` contract.** The engine's scheduler,
  driven: ticked every 25 ms while anything sounds, every duty
  `host-audio-system.md` §9 gives a host done once. That covers a late
  voice's entry point, a loop's wrap, gains before a voice is ready,
  unresolved tracks, a voice's end and a file's length. `Player`'s `audio`
  hands it the story's sound. Pinned by `test/soundscape.test.ts` against a
  recording speaker, which was seen to fail with each duty removed.
- **Named callbacks** by name: `Player.onCallback`, `onAnyCallback`,
  `clearCallbacks` and `callbackMisses`, the host-side table of
  `campaign-host-api.md` §5b. A handler runs where the engine placed the
  callback, an unregistered name is counted rather than refused, and a
  verb called from inside a handler throws `ReentrantVerb`.
- **A handler's error no longer cuts a batch short.** An `onEffect`,
  callback or sound handler that throws is reported to `onError`, or to
  `reportError`, and the rest of the batch is still delivered (§5b rule 3).
- **The rest of the host API's readers.** `Session.guard`,
  `Session.consoleFeed` and `Player.consoleFeed`, `Campaign.asText` and
  `Campaign.describeCvarRefusal`, so every reader of §6 is spelled.
- **A callback's `event` is the spec's name**, `cvar.changed`, as the
  author's `callbacks.json` spells it, not the WIT world's `cvar-changed`
  (`CallbackEventName`). Found by the fixtures' new `callbacks` list.
- Plays every conformance fixture of the release it carries, in Node through
  both `Session` and `Player`, and in Chromium, Firefox and WebKit through a
  Vite bundle loading each bundle over HTTP: 24 with Python, 21 without.
  Each fixture's named callbacks are compared as well as its trace.
