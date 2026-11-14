/** A Vakil id from a request: a non-empty string, otherwise null. */
export function parseVakilId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
