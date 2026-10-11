# A campaign in a page

The packages as a page uses them: a campaign opened from a folder, its
passages drawn with their pictures, its soundscapes played through the Web
Audio speaker, a language switch, mute, restart, and 1–9 for the choices. It
is where a developer starts from, and the **listening pass** for the
soundscape speaker, because a test can count voices but only a person can
hear a seam.

```sh
pnpm engine && pnpm build          # once, at the repository root
RIPPLE_CAMPAIGNS=<a folder of compiled bundles> pnpm --filter @ripplefx/example-player dev
```

A bundle is what the editor's **Export → Campaign** writes, or the engine's
`compile` binary. In the engine's repository, `melos run campaign:compile`
leaves *The City of Elsenmar* in `build/campaign/`, so pointing
`RIPPLE_CAMPAIGNS` there plays it. Each folder is served at `/<its name>/`, as
`demo.ripplefx.app` will serve it.

`node e2e.mjs [chromium|firefox|webkit]`, with the dev server on port 5179,
plays the first campaign by its first choices, three seconds a passage, and
prints what it saw: every picture's size, every audio file requested, and
whether the speaker's context ran.
