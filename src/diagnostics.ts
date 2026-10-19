/**
 * Diagnostics on stderr that name the namespace whose work they report (#239).
 *
 * One process can host several managers on one store, each with its own
 * namespace (agent-framework gives each agent `agents/<name>`), and their
 * lines interleave on stderr. A line about one namespace's work ends its
 * first line with ` ns=<namespace>`, after its own fields, so a grep for its
 * prefix still matches and a reader can keep one namespace's lines. A line
 * about what no one namespace owns, such as the store's own records or a
 * message slot the managers share, is logged as it is, through `console`,
 * which is a Diagnostics too.
 */
export interface Diagnostics {
  error(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
}

/** `message` with ` ns=<namespace>` at the end of its first line. */
export function withNamespace(message: string, namespace: string): string {
  const end = message.indexOf('\n');
  return end === -1
    ? `${message} ns=${namespace}`
    : `${message.slice(0, end)} ns=${namespace}${message.slice(end)}`;
}

/**
 * Diagnostics for one namespace's work. The namespace is read as each line
 * is logged, since a strategy learns its own at initialize, and so is
 * `console`, so a test's mock of console.error or console.warn sees the line.
 * Before it has one (a strategy no manager has initialized), a line names
 * none.
 */
export function namespaceDiagnostics(namespace: () => string): Diagnostics {
  const named = (message: string) => {
    const name = namespace();
    return name ? withNamespace(message, name) : message;
  };
  return {
    error: (message, ...rest) => console.error(named(message), ...rest),
    warn: (message, ...rest) => console.warn(named(message), ...rest),
  };
}
