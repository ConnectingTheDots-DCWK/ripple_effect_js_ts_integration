// The browser pass: the package bundled by Vite — the bundler under Astro and
// most pages — and every conformance fixture played in Chromium, Firefox and
// WebKit, in both variants, each trace compared in Node with expect.json.
//
//   pnpm browsers [chromium] [firefox] [webkit]
//
// Not in `pnpm test`: it needs Playwright's browsers (`pnpm exec playwright
// install chromium firefox webkit`, once). `.github/workflows/browsers.yml`
// runs it on dispatch. A browser that cannot launch is a failure, never a
// skip, so a pass names every browser it covered.
import { createReadStream, existsSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { build } from 'vite';
import { canonical, expected, FIXTURES, fixtureNames, input } from '../fixtures.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = join(here, 'out');
const engines = { chromium, firefox, webkit };
const asked = process.argv.slice(2);
const browsers = (asked.length ? asked : Object.keys(engines)) as (keyof typeof engines)[];

rmSync(out, { recursive: true, force: true });
await build({
  root: here,
  logLevel: 'warn',
  build: { outDir: out, emptyOutDir: true, target: 'es2022' },
});

const types: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};
const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
  const [root, rest] = path.startsWith('/fixtures/')
    ? [FIXTURES, path.slice('/fixtures/'.length)]
    : [out, path.slice(1) || 'index.html'];
  const base = resolve(root);
  const file = normalize(join(base, rest));
  if (!file.startsWith(base + sep) || !existsSync(file) || statSync(file).isDirectory()) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
});
await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('no port');
const origin = `http://127.0.0.1:${address.port}`;

const encode = (value: unknown) =>
  JSON.stringify(value, (_key, child) =>
    typeof child === 'bigint' ? { $int: `${child}` } : child,
  );

let failed = false;
const rows: string[] = [];
for (const name of browsers) {
  let browser: Awaited<ReturnType<(typeof engines)['chromium']['launch']>>;
  try {
    browser = await engines[name].launch();
  } catch (error) {
    failed = true;
    console.log(`${name}: could not launch — ${(error as Error).message.split('\n')[0]}`);
    continue;
  }
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/index.html`);
  await page.waitForFunction(() => window.ready === true);
  for (const python of [true, false]) {
    let played = 0;
    let skipped = 0;
    const started = performance.now();
    for (const fixture of fixtureNames()) {
      const given = input(fixture);
      if (!python && given.needs?.includes('python')) {
        skipped += 1;
        continue;
      }
      const wanted = expected(fixture);
      try {
        const got = await page.evaluate(
          ([fixtureName, text, withPython]) => window.play(fixtureName, text, withPython),
          [fixture, encode(given), python] as const,
        );
        const trace = wanted.trace.map(canonical);
        if (
          JSON.stringify(got.trace) !== JSON.stringify(trace) ||
          got.entities !== canonical(wanted.entities)
        ) {
          failed = true;
          console.log(`${name} ${python ? 'python' : 'no-python'} ${fixture}: the trace differs`);
        } else {
          played += 1;
        }
      } catch (error) {
        failed = true;
        console.log(
          `${name} ${python ? 'python' : 'no-python'} ${fixture}: ${(error as Error).message.split('\n')[0]}`,
        );
      }
    }
    const ms = Math.round(performance.now() - started);
    rows.push(
      `| ${name} ${browser.version()} | ${python ? 'python' : 'no-python'} | ${played} played, ${skipped} skipped | ${ms} ms |`,
    );
  }
  if (errors.length) {
    failed = true;
    console.log(`${name}: page errors — ${errors.join('; ')}`);
  }
  await browser.close();
}
server.close();

console.log('\n| Browser | Variant | Fixtures | Time |\n| --- | --- | --- | --- |');
for (const row of rows) console.log(row);
process.exit(failed ? 1 : 0);
