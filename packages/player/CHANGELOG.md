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
- Plays every conformance fixture of the release it carries, in Node through
  both `Session` and `Player`, and in Chromium, Firefox and WebKit through a
  Vite bundle loading each bundle over HTTP: 23 with Python, 20 without.
