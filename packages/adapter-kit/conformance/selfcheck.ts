// packages/adapter-kit/conformance/selfcheck.ts — the standing target of
// `pnpm conformance`: registers the conformance runner against the kit's own
// test doubles with no suites at all (plus covered registrations — emissions,
// an installer suite whose two cases share one config, a relay-timing
// payload through the real hearable-hook binary, and a redaction case — so
// every covered path is exercised too) and must exit 0 while printing every
// uncovered category. What this is for: proving the runner is green and
// honest with nothing registered — a run that silently passed zero assertions
// would be worthless here. What it must not do: register a failing scenario —
// the failing paths are unit-tested in test/, so this file is always the
// example of a green run.

import { registerConformance } from "../src/conformance/runner.js";
import {
  capableTestAdapter,
  installerDouble,
  leanTestAdapter,
  permittedEvents,
  selfcheckRedaction,
  selfcheckRelayTiming,
} from "../test/doubles.js";

// No suites registered: every category must be reported as not covered.
registerConformance(leanTestAdapter, {});

// One covered registration: an adapter whose emissions its capabilities
// permit must pass for real.
registerConformance(capableTestAdapter, {
  emissions: permittedEvents,
  relayTiming: selfcheckRelayTiming,
  redaction: selfcheckRedaction,
});

// A covered installer registration with shared state: the idempotence and
// byte-exact cases run back-to-back against the same config, proving each
// case gets its own clean baseline.
const installer = installerDouble();
registerConformance(installer.adapter, { installer: installer.suite });
