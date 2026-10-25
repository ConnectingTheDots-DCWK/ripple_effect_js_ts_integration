// A compiled campaign, opened in an engine of the variant it needs.
//
// A bundle is a folder served as it is (ADR *a-campaign-plays-in-a-page*,
// decision 1). `Campaign.load` reads `campaign.json`, fetches every document
// its tables name — boards, passages, components, scripts, machines,
// soundscapes — and opens the campaign with them and no media bytes. A
// picture or a sound is the page's to fetch, by the URL `mediaUrl` gives,
// when the story reaches it.
import type * as wit from '../generated/no-python/interfaces/ripple-engine-campaign.js';
import { type Soundscape, toSoundscape } from './effects.js';
import { Engine, type EngineOptions, type Variant } from './engine.js';
import { BundleError, bundleFailure, LoadError, NeedsPython } from './errors.js';
import { encodePath } from './media.js';
import { Session, type SessionStart } from './session.js';
import { fromArena, type RippleValue, toArena } from './values.js';

export interface CampaignOptions extends EngineOptions {
  /**
   * Which engine to load. `'auto'`, the default, takes the one the bundle's
   * `needs` asks for — the interpreter only for a campaign that uses it, and
   * always for a bundle older than format 15, which cannot say. `false` never
   * loads it, and refuses a campaign whose `needs` names it with
   * `NeedsPython`; `true` always does.
   */
  readonly python?: boolean | 'auto';
  /** Passed to every `fetch` the loader makes — credentials, a signal. */
  readonly fetch?: RequestInit;
  /**
   * Where a media file is, for a campaign opened `fromFiles`. A campaign
   * `load`ed from a URL resolves its media against that URL.
   */
  readonly mediaUrl?: (path: string) => URL | string | undefined;
}

/** One resource of the bundle: a board, a passage, a picture, a sound… */
export interface BundleEntry {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

export interface CampaignManifest {
  readonly format: number;
  readonly generator?: string;
  /** `markdown`, or `html` for a campaign exported as HTML. */
  readonly textFormat: string;
  readonly project: {
    readonly title: string;
    readonly description: string;
    readonly defaultLocale: string;
    readonly locales: readonly string[];
    /** The cover picture's path in the bundle. */
    readonly cover?: string;
  };
  /** The boards a story may begin on, as indices into `boards`. */
  readonly entries: readonly number[];
  readonly boards: readonly BundleEntry[];
  readonly passages: readonly BundleEntry[];
  readonly components: readonly BundleEntry[];
  readonly scripts: readonly BundleEntry[];
  readonly media: readonly BundleEntry[];
  readonly machines: readonly BundleEntry[];
  readonly soundscapes: readonly BundleEntry[];
  readonly cvars: readonly {
    readonly name: string;
    readonly type: string;
    readonly default: RippleValue;
  }[];
  /** What the campaign needs of an engine: `python` when it runs scripts. */
  readonly needs: readonly string[];
  /**
   * What the story reads of the world outside it — `dateTime`, `location` —
   * derived by the compiler. A session asks about each before it begins,
   * unless the host has answered already. A string rather than a
   * `PermissionKind`, because the list is open for appending.
   */
  readonly permissions: readonly string[];
}

/** A file of the bundle, as `fromFiles` takes it. */
export type BundleFiles =
  | ReadonlyMap<string, string | Uint8Array>
  | Readonly<Record<string, string | Uint8Array>>;

const DOCUMENT_TABLES = [
  'boards',
  'passages',
  'components',
  'scripts',
  'machines',
  'soundscapes',
] as const;

export class Campaign {
  readonly manifest: CampaignManifest;
  readonly #media: (path: string) => URL | undefined;

  private constructor(
    /** @internal */ readonly engine: Engine,
    /** @internal */ readonly handle: wit.Campaign,
    /** Which engine the campaign was opened in. */
    readonly variant: Variant,
    media: (path: string) => URL | undefined,
  ) {
    this.#media = media;
    this.manifest = engine.call(() => toManifest(handle.manifest()));
  }

  /**
   * Fetches and opens the bundle whose `campaign.json` is at `base` — a URL
   * ending in `/`, or the URL of `campaign.json` itself.
   */
  static async load(base: string | URL, options: CampaignOptions = {}): Promise<Campaign> {
    const root = new URL(base, globalThis.location?.href);
    if (root.pathname.endsWith('/campaign.json'))
      root.pathname = root.pathname.slice(0, -'campaign.json'.length);
    else if (!root.pathname.endsWith('/')) root.pathname += '/';
    const text = (url: URL) => fetchText(url, options.fetch);
    const manifestText = await text(new URL('campaign.json', root));
    const manifest = readManifest(manifestText);
    const paths = documentPaths(manifest);
    const [engine, documents] = await Promise.all([
      Engine.load(variantFor(manifest, options), options),
      Promise.all(
        paths.map(async (path) => ({ path, text: await text(new URL(encodePath(path), root)) })),
      ),
    ]);
    documents.unshift({ path: 'campaign.json', text: manifestText });
    return Campaign.#open(engine, documents, [], (path) => new URL(encodePath(path), root));
  }

  /**
   * Opens a bundle a host already holds — from a bundler, an archive, a
   * store. Text files are documents; anything given as bytes is handed to the
   * engine as an asset. Media are resolved by `options.mediaUrl`, if given.
   */
  static async fromFiles(files: BundleFiles, options: CampaignOptions = {}): Promise<Campaign> {
    const entries = files instanceof Map ? [...files] : Object.entries(files);
    const manifestText = entries.find(([path]) => path === 'campaign.json')?.[1];
    if (typeof manifestText !== 'string') {
      throw new BundleError({ kind: 'format', message: 'the bundle has no campaign.json' });
    }
    const manifest = readManifest(manifestText);
    const engine = await Engine.load(variantFor(manifest, options), options);
    const documents: wit.Document[] = [];
    const assets: wit.Asset[] = [];
    for (const [path, contents] of entries) {
      if (typeof contents === 'string') documents.push({ path, text: contents });
      else assets.push({ path, bytes: contents });
    }
    const resolve = options.mediaUrl;
    return Campaign.#open(engine, documents, assets, (path) => {
      const url = resolve?.(path);
      return url === undefined ? undefined : new URL(url, globalThis.location?.href);
    });
  }

  static #open(
    engine: Engine,
    documents: wit.Document[],
    assets: wit.Asset[],
    media: (path: string) => URL | undefined,
  ): Campaign {
    const handle = engine.call(
      (root) => root.campaign.Campaign.open(documents, assets),
      (failure) => new BundleError(bundleFailure(failure)),
    );
    return new Campaign(engine, handle, engine.variant, media);
  }

  /** Whether this campaign's engine has the interpreter. */
  get hasPython(): boolean {
    return this.engine.call((root) => root.engine.hasPython());
  }

  /** The engine's version, `MAJOR.MINOR.PATCH`. */
  get engineVersion(): string {
    return this.engine.call((root) => root.engine.version());
  }

  /** Where the media file at `index` is, or `undefined` for none. */
  mediaUrl(index: number): URL | undefined {
    const path = this.mediaPath(index);
    return path === undefined ? undefined : this.#media(path);
  }

  /** The media file's path in the bundle. */
  mediaPath(index: number): string | undefined {
    return this.engine.call(() => this.handle.mediaPath(index));
  }

  /** Where the project's cover picture is, if it has one. */
  get coverUrl(): URL | undefined {
    const cover = this.manifest.project.cover;
    return cover === undefined ? undefined : this.#media(cover);
  }

  /** The soundscape at `index` in the manifest's table. */
  soundscape(index: number): Soundscape {
    return this.engine.call(
      () => toSoundscape(this.handle.soundscape(index)),
      (failure) => new BundleError(bundleFailure(failure)),
    );
  }

  /** The index of the board whose catalog id is `id`. */
  boardIndex(id: string): number | undefined {
    return this.engine.call(() => this.handle.boardWithId(id));
  }

  /** What is wrong with the bundle, if anything: each problem and where. */
  validate(): { readonly message: string; readonly location: string }[] {
    return this.engine.call(() => this.handle.validate());
  }

  /** A value as the console variable type `type` would hold it, or `undefined`. */
  coerceCvar(type: string, value: RippleValue): RippleValue | undefined {
    return this.engine.call((root) => {
      const coerced = root.bundle.coerceCvar(type, toArena(value));
      return coerced === undefined ? undefined : fromArena(coerced);
    });
  }

  /** A value as the story prints it — runtime §6.1, the text a snippet shows. */
  asText(value: RippleValue): string {
    return this.engine.call((root) => root.values.asText(toArena(value)));
  }

  /** The sentence the engine refuses writing `value` to a variable of `type` with. */
  describeCvarRefusal(name: string, type: string, value: RippleValue): string {
    return this.engine.call((root) => root.bundle.describeCvarRefusal(name, type, toArena(value)));
  }

  /** A session on this campaign, not yet started. */
  session(options: SessionStart = {}): Session {
    return Session.create(this, options);
  }
}

// The bundle format that added `needs`. The compiler writes it whenever it is
// not empty, so from this format on an absent `needs` means none.
const NEEDS_FORMAT = 15;

function variantFor(
  manifest: { needs?: unknown; format?: unknown },
  options: CampaignOptions,
): Variant {
  const declared = Array.isArray(manifest.needs);
  // A bundle older than `needs` cannot say whether it runs scripts, so it is
  // given the interpreter rather than played with its scripts unavailable.
  const unknowable =
    !declared && typeof manifest.format === 'number' && manifest.format < NEEDS_FORMAT;
  const needsPython = declared ? (manifest.needs as unknown[]).includes('python') : unknowable;
  const wanted = options.python ?? 'auto';
  if (wanted === true) return 'python';
  if (wanted === false) {
    if (declared && needsPython) throw new NeedsPython();
    return 'no-python';
  }
  return needsPython ? 'python' : 'no-python';
}

// Read here, before any engine exists, for two things only: which tables to
// fetch and which engine to load. The engine reads it properly on open.
function readManifest(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Reported below, as the engine would.
  }
  throw new BundleError({
    kind: 'format',
    message: 'campaign.json is not a JSON object',
    location: 'campaign.json',
  });
}

function documentPaths(manifest: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  for (const table of DOCUMENT_TABLES) {
    const entries = manifest[table];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry && typeof entry.path === 'string') paths.add(entry.path);
    }
  }
  return [...paths];
}

async function fetchText(url: URL, init: RequestInit | undefined): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new LoadError(
      url.href,
      undefined,
      `${url.href} could not be fetched: ${(error as Error).message}`,
    );
  }
  if (!response.ok)
    throw new LoadError(url.href, response.status, `${url.href} answered ${response.status}`);
  return response.text();
}

function toManifest(
  raw: import('../generated/no-python/interfaces/ripple-engine-bundle.js').Manifest,
): CampaignManifest {
  const entries = (list: readonly BundleEntry[]) =>
    list.map(({ id, name, path }) => ({ id, name, path }));
  return {
    format: Number(raw.format),
    ...(raw.generator === undefined ? {} : { generator: raw.generator }),
    textFormat: raw.textFormat,
    project: {
      title: raw.project.title,
      description: raw.project.description,
      defaultLocale: raw.project.defaultLocale,
      locales: raw.project.locales,
      ...(raw.project.cover === undefined ? {} : { cover: raw.project.cover }),
    },
    entries: Array.from(raw.entries),
    boards: entries(raw.boards),
    passages: entries(raw.passages),
    components: entries(raw.components),
    scripts: entries(raw.scripts),
    media: entries(raw.media),
    machines: entries(raw.machines),
    soundscapes: entries(raw.soundscapes),
    cvars: raw.cvars.map((cvar) => ({
      name: cvar.name,
      type: cvar.type,
      default: fromArena(cvar.default),
    })),
    needs: raw.needs,
    permissions: raw.permissions,
  };
}
