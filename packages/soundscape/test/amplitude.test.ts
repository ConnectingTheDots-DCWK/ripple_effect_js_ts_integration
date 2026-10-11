import { expect, test } from 'vitest';
import { amplitude } from '../src/index.ts';

test("a gain is the editor's level, rendered on mpv's cubic curve", () => {
  expect(amplitude(1)).toBe(1);
  expect(amplitude(0.5)).toBe(0.125);
  expect(amplitude(0)).toBe(0);
  // Out of range, or not a number, is as quiet or as loud as allowed.
  expect(amplitude(2)).toBe(1);
  expect(amplitude(-1)).toBe(0);
  expect(amplitude(Number.NaN)).toBe(0);
});
