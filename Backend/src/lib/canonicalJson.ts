/**
 * Canonical JSON: object keys sorted lexicographically at every level, no
 * whitespace. Both Arcus signing schemes are defined over these exact bytes, so
 * `JSON.stringify` is not interchangeable here -- it preserves insertion order.
 *
 * Keys are compared by UTF-16 code unit, which matches a byte-wise sort for the
 * ASCII key sets Arcus uses.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    throw new Error("canonicalJson: undefined is not serialisable");
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`canonicalJson: non-finite number ${value}`);
    }
    if (typeof value === "bigint") return value.toString();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
