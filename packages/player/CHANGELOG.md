# Changelog

`MAJOR.MINOR` is the Ripple Effect contract this package binds; `PATCH` is the
package's own.

## 1.6.0

- **The engine of contract 1.6**, Grammar Lich: the world
  `ripple:engine@1.6.0`, bundle format 16. It also carries engine 1.5.1 to
  1.5.4, none of which changed the web component's surface.
- **A story may ask before it reads the clock or the reader's position.**
  A campaign whose `manifest.permissions` names a kind nobody has answered
  begins on a `permit` effect, a turn, and nothing else; `Session.permit`
  answers one kind, at any time, and the answer to the last begins the
  story. `setNow` hands it the host's instant (`momentOf()` makes one from a
  `Date`), `setPosition` a fix, and `setStandIn` what a reader would rather
  it believed, as typed. A read that did not get the real value is a
  `notice` effect, once per kind and outcome. `PermissionKind` is the spec's
  `dateTime`, not the world's `date-time`.
- **The `Player` is the story's clock.** Once the reader has allowed
  `dateTime` through `Player.permit`, every verb it makes is stamped with
  `now()` first, the machine's clock unless a host passes its own; never
  before. `Player.setStandIn` and `setPosition` pass through.
- **A passage may count down.** `Passage.timer`, a `ChoiceTimer`; the
  verbs `Session.beginCountdown` and `expire`; refusals `no-countdown` and
  `countdown-not-begun`; callback events `countdown.started` and
  `countdown.expired`. A `Player` runs the countdown itself — waits
  `afterMs`, begins it, waits `timeoutMs`, runs it out, and drops both waits
  when the story moves — and says where it stands to `onCountdown`.
  `countdowns: false` leaves it to the host, for a clock that does not wait
  or a reader who asked for no time limits.
- **A form speaks the reader's language and may offer fixed answers.**
  `PromptField` gains `label`, `placeholder`, `optional` and `options`, each
  a `PromptOption` with an `id`, a `label` and a `value`; a field with
  options is answered by the picked ids. A change of language re-announces a
  parked prompt in the new words, with its names and ids kept.
- `HostFailure` gains `not-permitted` and `stand-in`, the run trace's
  `nothing-on-wire` issue arrives as the engine spells it, and
  `CampaignManifest.permissions` lists what a story reads.
- **Fixed: a change of language during a wait stranded the story.** Any
  `Player` verb cancelled a pending `hold`, `setLocale` included, and a
  language change during a wait answers nothing, so the `elapsed` never
  came. `setLocale` and `permit` move nothing, and now leave the wait, and
  a countdown, running.
- Plays every conformance fixture of the 1.6 tree, 33 with Python and 27
  without, in Node through both `Session` and `Player` and in Chromium,
  Firefox and WebKit. The driver reads the fixtures' `now`, `permit` and
  `standIns`, the `countdown`, `expire` and `permit` moves, and records a
  passage's timer, a field's `optional` and `options`, and the `permit` and
  `notice` events.

## 1.5.0

- **A disposed `Player` moves the story no further.** `start`, `choose`,
  `answer`, `setLocale`, `restart` and `stop` do nothing after `dispose`,
  where they used to advance the session and deliver nothing of it; `pause`
  still answers a save. **`SoundscapeDriver.apply` throws a `RippleError`**
  for a soundscape that is a copy of the one the engine handed out, where it
  used to play silence. `RunEvent`, `TrackMode` and `CallbackKind` are
  exported, and `Campaign`'s internal `engine` and `handle` leave the
  declarations.
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
