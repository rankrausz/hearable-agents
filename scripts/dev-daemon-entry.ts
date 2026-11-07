// Development daemon composition root: exports the daemon plus the live adapters.
// It must not install hooks or add adapters that the production CLI does not support.
// Development daemon composition root: exposes live adapters to the bundle.
// It must not install hooks or add adapters the production CLI does not support.
import type { Adapter } from "../packages/adapter-kit/src/index.js";
import { claudeCodeAdapter } from "../packages/adapters/claude-code/src/index.js";
import { codexAdapter } from "../packages/adapters/codex/src/index.js";

export { loadConfig, startDaemon } from "../packages/daemon/src/index.js";

/** Keep development ingest identical to the production CLI composition root. */
export const LIVE_ADAPTERS: readonly Adapter[] = [claudeCodeAdapter, codexAdapter];
