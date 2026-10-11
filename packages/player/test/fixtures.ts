// The fixtures of the pinned release, read from disk for the Node suites:
// engine/conformance/, which `pnpm engine` unpacks.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RippleValue } from '../src/index.ts';
import type { Input, Played } from './driver.ts';

export { canonical } from './canonical.ts';

export const FIXTURES = fileURLToPath(
  new URL('../../../engine/conformance/fixtures/', import.meta.url),
);
export function fixtureNames(): string[] {
  return readdirSync(FIXTURES)
    .filter((name) => statSync(join(FIXTURES, name)).isDirectory())
    .sort();
}

/** JSON as the fixtures mean it: an integer literal is an Int, anything else a Float. */
export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'), (_key, value, context?: { source?: string }) =>
    typeof value === 'number' && context?.source !== undefined && /^-?\d+$/.test(context.source)
      ? BigInt(context.source)
      : value,
  );
}

/** A fixture's bundle as `Campaign.fromFiles` takes it. */
export function bundleFiles(name: string): Map<string, string | Uint8Array> {
  const root = join(FIXTURES, name, 'bundle');
  const files = new Map<string, string | Uint8Array>();
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else {
        const bytes = readFileSync(path);
        const key = relative(root, path).split(sep).join('/');
        try {
          files.set(key, utf8.decode(bytes));
        } catch {
          files.set(key, new Uint8Array(bytes));
        }
      }
    }
  };
  walk(root);
  return files;
}

export function input(name: string): Input {
  return readJson(join(FIXTURES, name, 'input.json')) as Input;
}

export function expected(name: string): Played {
  const raw = readJson(join(FIXTURES, name, 'expect.json')) as {
    trace: unknown[];
    entities?: Record<string, Record<string, RippleValue>>;
    callbacks?: unknown[];
  };
  return { trace: raw.trace, entities: raw.entities ?? {}, callbacks: raw.callbacks ?? [] };
}
