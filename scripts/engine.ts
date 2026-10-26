// Puts the pinned engine under engine/:
//
//   engine/python/ripple_engine.wasm      the component with the interpreter
//   engine/no-python/ripple_engine.wasm   the one without, importing nothing
//   engine/wit/                           the world both export
//   engine/NOTICE                         the Runtime Licence notice
//   engine/conformance/                   the fixtures and their FORMAT.md
//
// From the release engine.json pins: the manifest and its signature first,
// the signature checked against engine-signing.pub and nothing in the
// manifest believed before it, then every archive checked against both the
// manifest and the pin. The npm packages carry what this verified to every
// build that installs them, which is why it is stricter than a digest alone —
// a pin only proves a file has not changed since somebody first trusted it.
//
// `RIPPLE_ENGINE_TREE=<a ripple_effect checkout>` takes the components that
// checkout's `melos run wasm:build` made instead, and says loudly that nothing
// was verified. It is for working against an unreleased engine, and the
// publish workflow refuses it.

import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'engine');
const variants = ['python', 'no-python'] as const;

interface Pin {
  engine: string;
  contract: string;
  keyId: string | null;
  urls: string[];
  archives: Record<'python' | 'no-python' | 'conformance', { file: string; sha256: string | null }>;
}

const pin = JSON.parse(readFileSync(join(root, 'engine.json'), 'utf8')) as Pin;
const tree = process.env.RIPPLE_ENGINE_TREE;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

if (tree) {
  console.log(`engine ${fromTree(tree)}, unreleased, is in engine/`);
} else {
  await fromRelease();
  console.log(`engine ${pin.engine} is in engine/`);
}

/** Answers the engine version the tree is at. */
function fromTree(tree: string): string {
  console.warn(`engine: taking the components ${tree} built — UNVERIFIED, for development only.`);
  const version = treeVersion(tree);
  for (const variant of variants) {
    const component = join(tree, 'target', 'wasm', variant, 'ripple_engine.wasm');
    if (!existsSync(component)) {
      fail(`${component} is missing: run \`fvm dart run melos run wasm:build\` in ${tree}`);
    }
    mkdirSync(join(out, variant), { recursive: true });
    cpSync(component, join(out, variant, 'ripple_engine.wasm'));
  }
  cpSync(join(tree, 'crates', 'ripple-wasm', 'wit'), join(out, 'wit'), { recursive: true });
  const notice = execFileSync(
    'bash',
    [
      join(tree, 'tool', 'engine_notice.sh'),
      version,
      'wasm32-component',
      'python and no-python',
      'from a development tree, unreleased',
    ],
    { encoding: 'utf8' },
  );
  writeFileSync(join(out, 'NOTICE'), notice);
  mkdirSync(join(out, 'conformance'), { recursive: true });
  cpSync(
    join(tree, 'packages', 'ripple_runtime', 'test', 'fixtures'),
    join(out, 'conformance', 'fixtures'),
    { recursive: true },
  );
  cpSync(join(tree, 'tool', 'conformance', 'FORMAT.md'), join(out, 'conformance', 'FORMAT.md'));
  writeFileSync(join(out, 'UNVERIFIED'), `engine ${version}, taken from ${tree}\n`);
  return version;
}

// The engine's version in a checkout: its workspace's, which every crate
// takes. A tree opens the next contract before anything pins it, so this is
// what the notice names rather than engine.json's.
function treeVersion(tree: string): string {
  const manifest = readFileSync(join(tree, 'Cargo.toml'), 'utf8');
  const version = /^\[workspace\.package\][^[]*?^version\s*=\s*"([^"]+)"/ms.exec(manifest)?.[1];
  if (!version) fail(`${tree}/Cargo.toml names no workspace version`);
  return version;
}

async function fromRelease(): Promise<void> {
  const unpinned = Object.entries(pin.archives).filter(([, entry]) => entry.sha256 === null);
  if (pin.keyId === null || unpinned.length > 0) {
    fail(
      `engine.json pins no release yet (${unpinned.map(([name]) => name).join(', ')}).` +
        ' Set RIPPLE_ENGINE_TREE to a ripple_effect checkout to work against its build.',
    );
  }
  const tag = `engine-v${pin.engine}`;
  const manifestBytes = await download(tag, 'engine-manifest.json');
  const signature = (await download(tag, 'engine-manifest.json.sig')).toString('utf8').trim();
  const publicKey = Buffer.from(
    readFileSync(join(root, 'engine-signing.pub'), 'utf8').trim(),
    'base64',
  );
  const key = createPublicKey({
    // An Ed25519 SubjectPublicKeyInfo is this fixed prefix and the raw key.
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]),
    format: 'der',
    type: 'spki',
  });
  if (!verify(null, manifestBytes, key, Buffer.from(signature, 'base64'))) {
    fail('the manifest signature does not verify against engine-signing.pub');
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
  if (manifest.keyId !== keyId || pin.keyId !== keyId) {
    fail(
      `the manifest names key ${manifest.keyId}, engine.json ${pin.keyId}, the key file ${keyId}`,
    );
  }
  if (manifest.engine !== pin.engine || manifest.contract !== pin.contract) {
    fail(`the manifest is engine ${manifest.engine}, contract ${manifest.contract}`);
  }
  const listed: Record<keyof Pin['archives'], { archive: string; sha256: string }> = {
    python: manifest.variants.python['wasm32-component'],
    'no-python': manifest.variants['no-python']['wasm32-component'],
    conformance: manifest.conformance,
  };
  for (const [name, entry] of Object.entries(pin.archives) as [
    keyof Pin['archives'],
    Pin['archives']['python'],
  ][]) {
    const named = listed[name];
    if (!named || named.archive !== entry.file || named.sha256 !== entry.sha256) {
      fail(`${name}: the manifest and engine.json do not name the same archive`);
    }
    const bytes = await download(tag, entry.file);
    if (sha256(bytes) !== entry.sha256) fail(`${entry.file} is not the archive the manifest names`);
    const into = name === 'conformance' ? join(out, 'conformance') : join(out, name);
    untar(bytes, into);
  }
  // Each component archive holds lib/, wit/ and NOTICE; flatten to the layout
  // above, keeping one wit/ and one NOTICE — they are the same in both.
  for (const variant of variants) {
    cpSync(
      join(out, variant, 'lib', 'ripple_engine.wasm'),
      join(out, variant, 'ripple_engine.wasm'),
    );
  }
  cpSync(join(out, 'python', 'wit'), join(out, 'wit'), { recursive: true });
  cpSync(join(out, 'python', 'NOTICE'), join(out, 'NOTICE'));
}

async function download(tag: string, file: string): Promise<Buffer> {
  const problems: string[] = [];
  for (const template of pin.urls) {
    const url = template.replace('{tag}', tag).replace('{file}', file);
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      problems.push(`${url}: ${response.status}`);
    } catch (error) {
      problems.push(`${url}: ${(error as Error).message}`);
    }
  }
  fail(`could not download ${file}:\n  ${problems.join('\n  ')}`);
}

function untar(bytes: Buffer, into: string): void {
  const scratch = join(tmpdir(), `ripple-engine-${process.pid}-${Date.now()}.tar.gz`);
  writeFileSync(scratch, bytes);
  mkdirSync(into, { recursive: true });
  try {
    execFileSync('tar', ['-xzf', scratch, '-C', into]);
  } finally {
    rmSync(scratch, { force: true });
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(message: string): never {
  console.error(`engine: ${message}`);
  process.exit(1);
}
