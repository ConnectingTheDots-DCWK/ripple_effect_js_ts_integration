// What the fixtures do not reach: values through the engine and back, each
// refusal as the error that names it, a trap, and a bundle fetched over HTTP.

import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join, normalize } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  BundleError,
  Campaign,
  type Effect,
  EngineTrap,
  encodePath,
  HostError,
  LoadError,
  NeedsPython,
  Player,
  ReentrantVerb,
  resolveLink,
  Session,
} from '../src/index.ts';
import { bundleFiles, FIXTURES, input } from './fixtures.ts';

describe('values', () => {
  test('cross the engine and come back as they went', async () => {
    const campaign = await Campaign.fromFiles(bundleFiles('the-abacus'), { python: false });
    // `json` keeps a value as it is, so the engine hands back what it was given.
    const given = new Map<string, unknown>([
      ['big', 9_223_372_036_854_775_807n],
      ['small', -9_223_372_036_854_775_808n],
      ['nan', Number.NaN],
      ['up', Number.POSITIVE_INFINITY],
      ['down', Number.NEGATIVE_INFINITY],
      ['float', 7],
      ['int', 7n],
      ['list', [null, true, 'text', [1.5]]],
    ]);
    const back = campaign.coerceCvar('json', given as never) as Map<string, unknown>;
    expect(back).toBeInstanceOf(Map);
    expect([...back.keys()]).toEqual([...given.keys()]);
    expect(back.get('big')).toBe(9_223_372_036_854_775_807n);
    expect(back.get('small')).toBe(-9_223_372_036_854_775_808n);
    expect(back.get('nan')).toBeNaN();
    expect(back.get('up')).toBe(Number.POSITIVE_INFINITY);
    expect(back.get('down')).toBe(Number.NEGATIVE_INFINITY);
    expect(back.get('float')).toBe(7);
    expect(back.get('int')).toBe(7n);
    expect(back.get('list')).toEqual([null, true, 'text', [1.5]]);
    expect(() => campaign.coerceCvar('json', 2n ** 64n)).toThrow(RangeError);
  });
});

describe('refusals', () => {
  test('a verb out of turn is a HostError naming what was asked', async () => {
    const campaign = await Campaign.fromFiles(bundleFiles('the-abacus'), { python: false });
    const session = campaign.session({ seed: 1 });
    session.start();
    const thrown = (() => {
      try {
        session.elapsed();
      } catch (error) {
        return error;
      }
    })();
    expect(thrown).toBeInstanceOf(HostError);
    expect((thrown as HostError).failure).toMatchObject({
      kind: 'wrong-turn',
      answered: 'elapsed',
    });
  });

  test('an unreadable bundle is a BundleError, a missing table entry too', async () => {
    const files = bundleFiles('the-abacus');
    files.set('campaign.json', '{"format": 9999}');
    await expect(Campaign.fromFiles(files, { python: false })).rejects.toBeInstanceOf(BundleError);
    const campaign = await Campaign.fromFiles(bundleFiles('the-abacus'), { python: false });
    expect(() => campaign.soundscape(999)).toThrow(BundleError);
  });

  test('the engine follows the bundle: its needs, or Python when it is too old to say', async () => {
    // A fixture bundle predates `needs` (format 15), so it gets the interpreter.
    const old = bundleFiles('the-choir-loft');
    expect(input('the-choir-loft').needs).toContain('python');
    const legacy = await Campaign.fromFiles(old);
    expect([legacy.variant, legacy.hasPython]).toEqual(['python', true]);

    const declare = (needs: string[]) => {
      const files = bundleFiles('the-abacus');
      const manifest = JSON.parse(files.get('campaign.json') as string);
      files.set('campaign.json', JSON.stringify({ ...manifest, format: 15, needs }));
      return files;
    };
    expect((await Campaign.fromFiles(declare([]))).variant).toBe('no-python');
    expect((await Campaign.fromFiles(declare(['python']))).variant).toBe('python');
    await expect(Campaign.fromFiles(declare(['python']), { python: false })).rejects.toBeInstanceOf(
      NeedsPython,
    );
  });

  test('a trap ends the instance, and every later call says so', async () => {
    const campaign = await Campaign.fromFiles(bundleFiles('the-abacus'), { python: false });
    const session = Session.create(campaign, { seed: 1 });
    // No verb panics on purpose, so the trap is the one WebAssembly raises.
    expect(() =>
      campaign.engine.call(() => {
        throw new WebAssembly.RuntimeError('unreachable');
      }),
    ).toThrow(EngineTrap);
    expect(() => campaign.mediaPath(0)).toThrow(EngineTrap);
    expect(() => session.start()).toThrow(EngineTrap);
    const fresh = await Campaign.fromFiles(bundleFiles('the-abacus'), { python: false });
    expect(fresh.session({ seed: 1 }).start().at(-1)?.kind).toBe('show');
  });
});

describe('over HTTP', () => {
  let server: Server;
  let base: string;
  const requests: string[] = [];

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const path = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
      requests.push(path);
      const file = normalize(join(FIXTURES, path));
      try {
        response.end(await readFile(file));
      } catch {
        response.statusCode = 404;
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${address.port}/`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('a bundle loads from its folder, fetching the documents and no media', async () => {
    requests.length = 0;
    const campaign = await Campaign.load(new URL('the-choir/bundle/', base), { python: false });
    expect(requests).toContain('/the-choir/bundle/campaign.json');
    expect(requests.some((path) => path.includes('/media/'))).toBe(false);
    const media = campaign.manifest.media;
    expect(media.length).toBeGreaterThan(0);
    expect(campaign.mediaUrl(0)?.href).toBe(
      new URL(`the-choir/bundle/${encodePath(media[0]!.path)}`, base).href,
    );
    const first = campaign.session({ seed: 0 }).start();
    expect(first.at(-1)?.kind).toBe('show');
  });

  test('the URL of campaign.json itself is the same bundle', async () => {
    const campaign = await Campaign.load(new URL('the-abacus/bundle/campaign.json', base), {
      python: false,
    });
    expect(campaign.manifest.boards.length).toBeGreaterThan(0);
  });

  test('a bundle that is not there is a LoadError with the status', async () => {
    const failure = await Campaign.load(new URL('nowhere/', base), { python: false }).catch(
      (error) => error,
    );
    expect(failure).toBeInstanceOf(LoadError);
    expect((failure as LoadError).status).toBe(404);
  });
});

describe('media', () => {
  test('a path is encoded a segment at a time', () => {
    expect(encodePath('media/The Tavern/ünder #1?.mp3')).toBe(
      'media/The%20Tavern/%C3%BCnder%20%231%3F.mp3',
    );
  });

  test('a link in the prose resolves through the passage, and others are left alone', () => {
    const passage = {
      media: new Map([
        ['/images/cover.jpg', new URL('https://demo.example/c/media/images/cover.jpg')],
      ]),
    } as unknown as Parameters<typeof resolveLink>[0];
    expect(resolveLink(passage, '/images/cover.jpg')).toBe(
      'https://demo.example/c/media/images/cover.jpg',
    );
    expect(resolveLink(passage, 'https://elsewhere.example/a.png')).toBe(
      'https://elsewhere.example/a.png',
    );
  });
});

// A fixture with named callbacks declared on its manifest, as the compiler
// writes them (`campaign-bundle.md` §3): no fixture declares any.
async function withCallbacks(...callbacks: { name: string; event: string }[]): Promise<Campaign> {
  const files = bundleFiles('the-abacus');
  const manifest = JSON.parse(files.get('campaign.json') as string);
  files.set('campaign.json', JSON.stringify({ ...manifest, callbacks }));
  return Campaign.fromFiles(files, { python: false });
}

describe('callbacks', () => {
  test('a handler runs where the engine placed it, and an unregistered name is a miss', async () => {
    const campaign = await withCallbacks(
      { name: 'begun', event: 'story.started' },
      { name: 'shown', event: 'passage.shown' },
      { name: 'nobody', event: 'board.entered' },
    );
    const seen: string[] = [];
    const player = new Player(campaign.session({ seed: 1 }), {
      onEffect: (effect) => seen.push(effect.kind),
    });
    player.onCallback('shown', (fired) => seen.push(`handler:${fired.callback}`));
    const begun = player.onCallback('begun', () => seen.push('handler:begun'));
    begun();
    const every: string[] = [];
    player.onAnyCallback((fired) => every.push(fired.callback));
    player.start();
    // Before the passage it is about, and only the registered name.
    expect(seen.indexOf('handler:shown')).toBeLessThan(seen.indexOf('show'));
    expect(seen).not.toContain('handler:begun');
    expect(every.sort()).toEqual(['begun', 'nobody', 'shown']);
    expect(player.callbackMisses).toBe(2);
  });

  test('a handler that throws is reported, and the rest of the batch still arrives', async () => {
    const campaign = await withCallbacks({ name: 'shown', event: 'passage.shown' });
    const errors: unknown[] = [];
    const kinds: string[] = [];
    const player = new Player(campaign.session({ seed: 1 }), {
      onEffect: (effect) => kinds.push(effect.kind),
      onError: (error) => errors.push(error),
    });
    player.onCallback('shown', () => {
      throw new Error('the game fell over');
    });
    player.start();
    expect((errors[0] as Error).message).toBe('the game fell over');
    expect(kinds.at(-1)).toBe('show');
    expect(player.turn?.kind).toBe('show');
  });

  test('a verb from inside a handler is refused, and the batch is not cut short', async () => {
    const campaign = await Campaign.fromFiles(bundleFiles('the-abacus'), { python: false });
    const errors: unknown[] = [];
    const kinds: Effect['kind'][] = [];
    const player = new Player(campaign.session({ seed: 1 }), {
      onEffect: (effect) => {
        kinds.push(effect.kind);
        if (effect.kind === 'show') player.choose(0);
      },
      onError: (error) => errors.push(error),
    });
    player.start();
    expect(errors[0]).toBeInstanceOf(ReentrantVerb);
    expect(kinds.filter((kind) => kind === 'show')).toHaveLength(1);
  });
});

describe('the player', () => {
  test('a disposed player moves the story no further, and still answers a save', async () => {
    const campaign = await Campaign.fromFiles(bundleFiles('the-abacus'), { python: false });
    const session = campaign.session({ seed: 1 });
    const seen: Effect[] = [];
    const player = new Player(session, { onEffect: (effect) => seen.push(effect) });
    player.start();
    const parked = session.checkpoint();
    expect(parked).toBeDefined();
    player.dispose();
    player.stop();
    expect(session.checkpoint()).toBe(parked);
    expect(seen.some((effect) => effect.kind === 'stopped')).toBe(false);
    expect(player.pause()).toBeDefined();
  });
});

describe('the console and the guard', () => {
  test('a line of Python answers its value, its output and its failure', async () => {
    const campaign = await Campaign.fromFiles(bundleFiles('the-abacus'), { python: true });
    const session = campaign.session({ seed: 1 });
    session.start();
    expect(session.consoleFeed('1 + 2').result).toEqual({ value: 3n, output: '' });
    expect(session.consoleFeed('print("hi")').result.output).toBe('hi\n');
    expect(session.consoleFeed('nowhere').result.error?.type).toBe('NameError');
    expect(session.guard).toEqual({ abandoned: [], refused: 0, exhausted: false });
  });

  test('without Python the console answers unavailable rather than throwing', async () => {
    const campaign = await Campaign.fromFiles(bundleFiles('the-abacus'), { python: false });
    const session = campaign.session({ seed: 1 });
    session.start();
    expect(session.consoleFeed('1 + 2').result.error?.type).toBe('unavailable');
  });

  test('a value prints as the story prints it, and a refusal reads as the engine says it', async () => {
    const campaign = await Campaign.fromFiles(bundleFiles('the-abacus'), { python: false });
    expect(campaign.asText(7n)).toBe('7');
    // A Float that happens to be whole still prints as a Float.
    expect(campaign.asText(7)).not.toBe(campaign.asText(7n));
    expect(campaign.describeCvarRefusal('gold', 'int', 'lots')).toContain('gold');
  });
});
