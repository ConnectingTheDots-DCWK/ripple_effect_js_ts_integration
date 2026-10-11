// Turns the engine `pnpm engine` put under the repository's engine/ into what
// this package ships, under generated/:
//
//   generated/<variant>/engine.js           jco's glue, in async instantiation
//   generated/<variant>/engine.d.ts         and its types, from the world
//   generated/<variant>/engine.core*.wasm   the core modules src/engine.ts loads
//
// and copies the engine's NOTICE beside the package as ENGINE-NOTICE, which
// the Runtime Licence asks every copy to carry. `--instantiation async`
// leaves the loading of the core modules to the binding, so one output runs in
// Node and every browser; `--no-nodejs-compat` drops jco's own Node loader,
// whose `import('node:fs/promises')` a browser bundler would trip on and which
// that mode never calls (ADR *a-campaign-plays-in-a-page*, decision 2).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const engine = join(here, '..', '..', 'engine');
// jco exports no package.json to resolve, so its binary is reached by path.
const jco = join(here, 'node_modules', '@bytecodealliance', 'jco', 'dist', 'jco.js');

for (const variant of ['python', 'no-python']) {
  const component = join(engine, variant, 'ripple_engine.wasm');
  if (!existsSync(component)) {
    console.error(
      `transpile: ${component} is missing — run \`pnpm engine\` at the repository root first`,
    );
    process.exit(1);
  }
  const out = join(here, 'generated', variant);
  rmSync(out, { recursive: true, force: true });
  execFileSync(
    process.execPath,
    [
      jco,
      'transpile',
      component,
      '-o',
      out,
      '--name',
      'engine',
      '--instantiation',
      'async',
      '--no-nodejs-compat',
      '-q',
    ],
    { stdio: 'inherit' },
  );
  // jco keeps a loader of its own for a caller that passes no getCoreModule,
  // as `new URL(`./${name}`, import.meta.url)`. This binding always passes
  // one, and a bundler reading that template globs the whole directory —
  // Vite copied engine.d.ts into a page's assets for it. So the fallback is
  // taken out, and a jco whose output no longer has it fails here, to be
  // looked at, rather than shipping a stray glob.
  const glue = join(out, 'engine.js');
  // biome-ignore lint/suspicious/noTemplateCurlyInString: jco's source text, matched literally.
  const fallback = 'fetchCompile(new URL(`./${name}`, import.meta.url))';
  const text = readFileSync(glue, 'utf8');
  if (text.split(fallback).length !== 2) {
    console.error(`transpile: ${glue} no longer has jco's own core-module loader exactly once`);
    process.exit(1);
  }
  writeFileSync(
    glue,
    text.replace(
      fallback,
      "Promise.reject(new Error('@ripplefx/player always loads the core modules itself'))",
    ),
  );
}
copyFileSync(join(engine, 'NOTICE'), join(here, 'ENGINE-NOTICE'));
