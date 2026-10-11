// How two traces are compared, with nothing imported, so the browser pass's
// runner can use it under plain Node.
/**
 * A value as text that keeps what the fixtures assert: an Int and a Float of
 * the same size differ, NaN is NaN, and an object's key order does not count.
 */
export function canonical(value: unknown): string {
  if (typeof value === 'bigint') return `${value}`;
  if (typeof value === 'number') return Number.isInteger(value) ? `${value}.0` : `${value}`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = value instanceof Map ? [...value] : Object.entries(value);
  return `{${entries
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`;
}
