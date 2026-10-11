# Changelog

`MAJOR.MINOR` is the Ripple Effect contract this package binds; `PATCH` is the
package's own.

## Unreleased — 1.5.0

- **The first release.** The engine of contract 1.5, both variants, as
  WebAssembly components transpiled by jco 1.37.0 in async instantiation.
  `Campaign.load` serves a bundle as a folder, `Session` is the host API one
  to one, and `Player` is the loop over it with the clock for a `hold`.
- Plays every conformance fixture of the release it carries, in Node through
  both `Session` and `Player`, and in Chromium, Firefox and WebKit through a
  Vite bundle loading each bundle over HTTP: 23 with Python, 20 without.
