# Contributing

Start with [AGENTS.md](AGENTS.md) and the [architecture overview](docs/ARCHITECTURE.md).
The project is a development preview. Discuss scope before adding integrations or changing
what sounds mean.

Useful contributions include reproducible defects, accurately annotated redacted fixtures,
adapter conformance fixes, and precise listening observations. Include reproduction steps,
expected/actual behavior, affected checks, and known limitations. Do not include raw private
prompts, tool output, repository paths, or credentials.

Run `pnpm lint`, `pnpm typecheck`, and affected tests. Core changes need invariants and
trajectory checks; adapter changes need conformance; audible paths need numeric QA and
human listening; Mac changes need native smoke. See [verification](docs/VERIFICATION.md).

Code is MIT licensed. Audio assets may have separate redistribution licenses; each must
be recorded with source, modifications, attribution, and license in the
[asset ledger](packages/audio/src/scenes/clearing/ASSETS.md). Existing piano samples are
CC BY 3.0, not MIT or CC0.
