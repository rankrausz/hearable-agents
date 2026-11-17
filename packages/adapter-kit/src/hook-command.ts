// Quotes and reads individual shell arguments emitted by the hook installers.
export function quoteHookArgument(value: string): string {
  return /^[\w./:-]+$/.test(value) ? value : `"${value.replace(/["\\$`]/g, "\\$&")}"`;
}

export function firstHookArgument(command: string): string | null {
  const quoted = /^"((?:\\.|[^"\\])*)"(?:\s|$)/.exec(command);
  if (quoted?.[1] !== undefined) return quoted[1].replace(/\\(["\\$`])/g, "$1");
  return /^\S+/.exec(command)?.[0] ?? null;
}
