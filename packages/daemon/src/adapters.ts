// packages/daemon/src/adapters.ts — the adapter registry. What this is for:
// resolving `x-hearable-agent` header values (and event `agent` fields) to the
// adapters wired into the daemon, so raw payloads can run through an
// adapter's pure `map`. What it must not do: import any concrete adapter or
// know an agent by name — the composition root (the CLI, p1-t11) injects the
// installed adapters, and the daemon stays coupled only to the Adapter
// contract from @hearable/adapter-kit.

import type { Adapter } from "@hearable/adapter-kit";

export type AdapterRegistry = ReadonlyMap<string, Adapter>;

/**
 * Builds the id → adapter map, failing fast on duplicate ids so a wiring
 * mistake at startup is loud instead of silently shadowing an adapter.
 */
export function createAdapterRegistry(adapters: readonly Adapter[]): AdapterRegistry {
  const registry = new Map<string, Adapter>();
  for (const adapter of adapters) {
    if (registry.has(adapter.id)) {
      throw new Error(
        `Two adapters claim the same id "${adapter.id}". The daemon cannot tell them apart; fix the wiring.`,
      );
    }
    registry.set(adapter.id, adapter);
  }
  return registry;
}
