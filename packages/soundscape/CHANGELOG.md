# Changelog

`MAJOR.MINOR` is the Ripple Effect contract this package works with;
`PATCH` is the package's own.

## 1.6.0

- **Works with `@ripplefx/player` 1.6**, which it now peers on. The speaker
  contract did not change with the contract: nothing in a soundscape's
  sound is new in 1.6.

## 1.5.0

- **The first release.** `WebAudioSpeaker` implements `@ripplefx/player`'s
  `Speaker`. A track streams through a media element into a gain node; a cue
  is decoded once and started from its buffer. Gains are on the editor's
  scale (`amplitude(gain) = gain ** 3`, mpv's curve), smoothed between the
  scheduler's steps. `unlock()` is the gesture every browser asks for.
- **An element is routed into Web Audio once it is playing, not before**,
  and a file's own end is watched for as well as heard. WebKitGTK stalls an
  element routed while it loads, and never fires `ended` for one that is
  routed. Both were found by the browser pass, which passes in Chromium 153,
  Firefox 155 and WebKit 26.6.
