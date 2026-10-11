// Every conformance fixture of the pinned release, played through this
// package's API in both variants and through both hosts, and compared with
// what the reader must have seen. 24 with Python; 21 without, the three that
// need it skipped on their `needs` — ADR *a-campaign-plays-in-a-page*, 11.
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Campaign } from '../src/index.ts';
import { play } from './driver.ts';
import { bundleFiles, canonical, expected, fixtureNames, input } from './fixtures.ts';

const names = fixtureNames();

beforeAll(() => {
  vi.useFakeTimers();
});
afterAll(() => {
  vi.useRealTimers();
});

test('the release carries the fixtures', () => {
  expect(names.length).toBe(24);
});

for (const python of [true, false]) {
  describe(python ? 'python' : 'no-python', () => {
    const played: string[] = [];
    const skipped: string[] = [];

    for (const name of names) {
      for (const through of ['session', 'player'] as const) {
        test(`${name}, through the ${through}`, async () => {
          const fixture = input(name);
          const campaign = await Campaign.fromFiles(bundleFiles(name), { python });
          if (fixture.needs?.includes('python') && !campaign.hasPython) {
            if (through === 'session') skipped.push(name);
            return;
          }
          const got = play(campaign, fixture, through, () => vi.runAllTimers());
          const wanted = expected(name);
          expect(got.trace.map(canonical)).toEqual(wanted.trace.map(canonical));
          expect(canonical(got.entities)).toBe(canonical(wanted.entities));
          expect(got.callbacks.map(canonical)).toEqual(wanted.callbacks.map(canonical));
          if (through === 'session') played.push(name);
        });
      }
    }

    test('plays every fixture it can, and skips only those needing Python', () => {
      expect(played.length + skipped.length).toBe(names.length);
      expect(skipped.length).toBe(python ? 0 : 3);
    });
  });
}
