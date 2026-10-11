// The engine as one instance of one of its two components.
//
// Both are transpiled by jco in its asynchronous instantiation mode, which
// hands this file the loading of the core modules: one output runs in Node
// and in every browser, and a bundler sees each `.wasm` as a
// `new URL(…, import.meta.url)` and copies it beside the page (ADR
// *a-campaign-plays-in-a-page*, decision 2).
import type { Root } from '../generated/no-python/engine.js';
import { EngineTrap, LoadError } from './errors.js';

/** Which build of the engine: with the Python interpreter, or without. */
export type Variant = 'python' | 'no-python';

export interface EngineOptions {
  /**
   * Where the engine's `.wasm` files are served from, when not beside this
   * package — a CDN, say. It holds `python/` and `no-python/` directories as
   * the package's `generated/` does.
   */
  readonly wasmBase?: string | URL;
}

// Literal, so that a bundler can find every file. jco names a component's
// core modules engine.core.wasm, engine.core2.wasm and so on.
const packaged: Record<Variant, Record<string, () => URL>> = {
  python: {
    'engine.core.wasm': () => new URL('../generated/python/engine.core.wasm', import.meta.url),
    'engine.core2.wasm': () => new URL('../generated/python/engine.core2.wasm', import.meta.url),
    'engine.core3.wasm': () => new URL('../generated/python/engine.core3.wasm', import.meta.url),
  },
  'no-python': {
    'engine.core.wasm': () => new URL('../generated/no-python/engine.core.wasm', import.meta.url),
    'engine.core2.wasm': () => new URL('../generated/no-python/engine.core2.wasm', import.meta.url),
    'engine.core3.wasm': () => new URL('../generated/no-python/engine.core3.wasm', import.meta.url),
  },
};

// Compiled once per page and instantiated per campaign: compiling is the
// expensive half, and an instance is what a trap ruins.
const compiled = new Map<string, Promise<WebAssembly.Module>>();

function locate(variant: Variant, path: string, options: EngineOptions): URL {
  if (options.wasmBase !== undefined) {
    return new URL(`${variant}/${path}`, new URL(options.wasmBase, globalThis.location?.href));
  }
  const url = packaged[variant][path];
  if (!url) throw new Error(`the ${variant} engine has no core module ${path}`);
  return url();
}

function compile(url: URL): Promise<WebAssembly.Module> {
  const key = url.href;
  let module = compiled.get(key);
  if (!module) {
    module = compileFrom(url);
    compiled.set(key, module);
    module.catch(() => compiled.delete(key));
  }
  return module;
}

async function compileFrom(url: URL): Promise<WebAssembly.Module> {
  if (url.protocol === 'file:') {
    // Node, running the package from disk. Spelled so that no bundler tries
    // to resolve it for a browser, where this branch is never taken.
    const fs = 'node:fs/promises';
    const { readFile } = (await import(/* @vite-ignore */ fs)) as {
      readFile(url: URL): Promise<Uint8Array<ArrayBuffer>>;
    };
    return WebAssembly.compile(await readFile(url));
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new LoadError(url.href, response.status, `${url.href} answered ${response.status}`);
  }
  // Streaming compilation needs the server to say application/wasm; a server
  // that does not is answered the slower way rather than refused.
  if (response.headers.get('content-type')?.startsWith('application/wasm')) {
    return WebAssembly.compileStreaming(response);
  }
  return WebAssembly.compile(await response.arrayBuffer());
}

/**
 * One instance of the engine. Every call goes through `call`, which turns a
 * trap into `EngineTrap` and refuses every call after it.
 */
export class Engine {
  #trap: EngineTrap | undefined;

  private constructor(
    readonly variant: Variant,
    readonly root: Root,
  ) {}

  static async load(variant: Variant, options: EngineOptions = {}): Promise<Engine> {
    const getCoreModule = (path: string) => compile(locate(variant, path, options));
    let root: Root;
    if (variant === 'python') {
      const [glue, shim] = await Promise.all([
        import('../generated/python/engine.js'),
        import('@bytecodealliance/preview2-shim/instantiation'),
      ]);
      // The interpreter's WASI, with nothing behind it: no files, no
      // environment, no network. The engine asks WASI for a clock and for
      // entropy, and nothing else.
      const wasi = new shim.WASIShim({
        sandbox: { preopens: {}, env: {}, args: ['ripple'], enableNetwork: false },
      });
      root = (await glue.instantiate(getCoreModule, wasi.getImportObject() as never)) as Root;
    } else {
      const glue = await import('../generated/no-python/engine.js');
      root = await glue.instantiate(getCoreModule, {} as never);
    }
    return new Engine(variant, root);
  }

  /** Runs `body` against the engine, mapping a refusal with `refused`. */
  call<T>(body: (root: Root) => T, refused?: (payload: never) => Error): T {
    if (this.#trap) throw this.#trap;
    try {
      return body(this.root);
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) {
        this.#trap = new EngineTrap(error);
        throw this.#trap;
      }
      if (refused && isComponentError(error)) throw refused(error.payload as never);
      throw error;
    }
  }

  /** Whether a trap has ended this instance. */
  get trapped(): boolean {
    return this.#trap !== undefined;
  }
}

// jco's ComponentError sets no `name`, and a minifier renames its class, so
// it is known by the one thing it always has: `payload`, set on the instance.
function isComponentError(error: unknown): error is Error & { payload: unknown } {
  return error instanceof Error && Object.hasOwn(error, 'payload');
}
