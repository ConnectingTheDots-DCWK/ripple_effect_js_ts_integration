// The speaker's browser pass: real voices in Chromium, Firefox and WebKit,
// timed against what they were asked to do.
//
//   pnpm --filter @ripplefx/soundscape browsers [chromium] [firefox] [webkit]
//
// Times are loose on purpose — a headless browser's audio clock is not a
// concert — and what is asserted is the shape: a whole file ends near its
// length, a clip near its `to`, a loop not at all, a paused cue later than a
// free one, a stopped voice never.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { build, preview } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = `${here}out`;
const engines = { chromium, firefox, webkit };
const asked = process.argv.slice(2);
const browsers = (asked.length ? asked : Object.keys(engines)) as (keyof typeof engines)[];

rmSync(out, { recursive: true, force: true });
await build({
  root: here,
  logLevel: 'warn',
  build: { outDir: out, emptyOutDir: true, target: 'es2022' },
});
const server = await preview({
  root: here,
  build: { outDir: out },
  preview: { port: 0, host: '127.0.0.1' },
  logLevel: 'warn',
});
const origin = server.resolvedUrls?.local[0] ?? '';

const checks: [string, (r: Record<string, number | null>) => boolean][] = [
  [
    'a whole file ends near its length',
    (r) => r.trackEnded !== null && r.trackEnded! > 700 && r.trackEnded! < 2_500,
  ],
  [
    'its length is reported',
    (r) => r.trackDuration !== null && Math.abs(r.trackDuration! - 1_000) < 50,
  ],
  [
    'a clip ends near its `to`',
    (r) => r.clippedEnded !== null && r.clippedEnded! > 150 && r.clippedEnded! < 1_000,
  ],
  ['a loop does not end', (r) => r.loopEnded === null],
  [
    'a cue ends near its length',
    (r) => r.cueEnded !== null && r.cueEnded! > 350 && r.cueEnded! < 1_500,
  ],
  [
    'a cue reports its length',
    (r) => r.cueDuration !== null && Math.abs(r.cueDuration! - 500) < 20,
  ],
  ['a paused cue ends later by the pause', (r) => r.heldEnded !== null && r.heldEnded! > 850],
  ['a stopped voice never ends', (r) => r.stoppedEnded === null],
];

let failed = false;
for (const name of browsers) {
  const browser = await engines[name]
    .launch(
      name === 'chromium'
        ? { args: ['--autoplay-policy=no-user-gesture-required'] }
        : name === 'firefox'
          ? { firefoxUserPrefs: { 'media.autoplay.default': 0 } }
          : {},
    )
    .catch((error: Error) => {
      failed = true;
      console.log(`${name}: could not launch — ${error.message.split('\n')[0]}`);
      return undefined;
    });
  if (!browser) continue;
  const page = await browser.newPage();
  await page.goto(`${origin}index.html`);
  await page.click('#begin');
  const results = (await page.evaluate(() => window.results)) as Record<string, number | null> & {
    error?: string;
  };
  if (results.error) {
    failed = true;
    console.log(`${name}: ${results.error}`);
  }
  for (const [what, holds] of checks) {
    const ok = holds(results);
    if (!ok) failed = true;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${browser.version()}: ${what}`);
  }
  console.log(`     ${name} timings: ${JSON.stringify(results)}`);
  await browser.close();
}
await server.close();
process.exit(failed ? 1 : 0);
