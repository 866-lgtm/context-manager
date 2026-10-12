/**
 * A thrown value as text, for a diagnostic that must not fail in its turn:
 * an Error's message, else the value's String form, else its
 * Object.prototype.toString tag. String() throws on an object with no
 * prototype, and both throw on a revoked Proxy, so a log line built with
 * String(err) could replace the outcome it reports, such as a compile that
 * stands or a write's own error.
 */
export function describeThrown(value: unknown): string {
  try {
    return String(value instanceof Error ? value.message : value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return 'a value that cannot be printed';
    }
  }
}
