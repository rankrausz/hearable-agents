// Quotes and reads individual shell arguments emitted by the hook installers.
export function quoteHookArgument(value: string): string {
  return /^[\w./:-]+$/.test(value) ? value : `"${value.replace(/["\\$`]/g, "\\$&")}"`;
}

export function firstHookArgument(command: string): string | null {
  const quoted = /^"((?:\\.|[^"\\])*)"(?:\s|$)/.exec(command);
  if (quoted?.[1] !== undefined) return quoted[1].replace(/\\(["\\$`])/g, "$1");
  return /^\S+/.exec(command)?.[0] ?? null;
}

const CHECK_RELAY = "[ -x ";

/** The installed app can move or disappear while the agent still has its hooks. */
export function guardHookCommand(relayPath: string, args: string): string {
  const executable = quoteHookArgument(relayPath);
  return `${CHECK_RELAY}${executable} ] && ${executable}${args} || true`;
}

export function hookExecutable(command: string): string | null {
  return firstHookArgument(
    command.startsWith(CHECK_RELAY) ? command.slice(CHECK_RELAY.length) : command,
  );
}
