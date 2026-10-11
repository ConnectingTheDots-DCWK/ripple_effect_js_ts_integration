// A story's values, as JavaScript holds them, and the arena the engine
// carries them in.
//
// WIT has no recursive types, so a value crosses the component boundary as a
// flat list of nodes with the root at 0, a list or a map naming its children
// by index (ADR *the-web-loads-a-component*, decision 5). A host never sees
// that: every value in this package is a `RippleValue`, converted at the edge.
import type * as wit from '../generated/no-python/interfaces/ripple-engine-values.js';

/**
 * A value a story holds: `null`, a boolean, an **Int as a `bigint`**, a
 * **Float as a `number`**, a string, a list, or a map whose key order is the
 * engine's.
 *
 * Int and Float are different types to the engine and stay different here:
 * `7n` is an Int and `7` is a Float, a story may compare them and get
 * `false`, and an Int keeps all 64 of its bits. NaN and the infinities are
 * Floats and survive the round trip.
 */
export type RippleValue =
  | null
  | boolean
  | bigint
  | number
  | string
  | readonly RippleValue[]
  | ReadonlyMap<string, RippleValue>;

/** Reads an arena into a value. */
export function fromArena(arena: wit.Value): RippleValue {
  const read = (at: number): RippleValue => {
    const node = arena.nodes[at];
    if (node === undefined) throw new RangeError(`the value has no node ${at}`);
    switch (node.tag) {
      case 'null':
        return null;
      case 'boolean':
      case 'int':
      case 'float':
      case 'text':
        return node.val;
      case 'items':
        return Array.from(node.val, read);
      case 'entries':
        return new Map(node.val.map(([key, child]) => [key, read(child)]));
    }
  };
  return read(0);
}

/**
 * Writes a value as an arena. A plain object is taken as a map, in its own
 * key order, so a host may write `{ gold: 3n }` where it means one.
 */
export function toArena(value: RippleValue | Readonly<Record<string, RippleValue>>): wit.Value {
  const nodes: wit.ValueNode[] = [];
  const write = (value: unknown): number => {
    const at = nodes.length;
    nodes.push({ tag: 'null' });
    let node: wit.ValueNode;
    if (value === null || value === undefined) {
      node = { tag: 'null' };
    } else if (typeof value === 'boolean') {
      node = { tag: 'boolean', val: value };
    } else if (typeof value === 'bigint') {
      node = { tag: 'int', val: BigInt.asIntN(64, value) };
      if (node.val !== value) throw new RangeError(`${value} does not fit a 64-bit Int`);
    } else if (typeof value === 'number') {
      node = { tag: 'float', val: value };
    } else if (typeof value === 'string') {
      node = { tag: 'text', val: value };
    } else if (Array.isArray(value)) {
      node = { tag: 'items', val: Uint32Array.from(value.map(write)) };
    } else if (value instanceof Map) {
      node = { tag: 'entries', val: [...value].map(([key, child]) => [String(key), write(child)]) };
    } else if (typeof value === 'object') {
      node = {
        tag: 'entries',
        val: Object.entries(value as Record<string, unknown>).map(([key, child]) => [
          key,
          write(child),
        ]),
      };
    } else {
      throw new TypeError(`a ${typeof value} is not a story value`);
    }
    nodes[at] = node;
    return at;
  };
  write(value);
  return { nodes };
}

/** A map value's entries as an object, for a host that prefers one. */
export function asRecord(value: RippleValue): Record<string, RippleValue> {
  return value instanceof Map ? Object.fromEntries(value) : {};
}
