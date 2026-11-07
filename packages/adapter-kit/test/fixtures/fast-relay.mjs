// packages/adapter-kit/test/fixtures/fast-relay.mjs — a fast stub relay for
// the relay-timing negative control: accepts its flags, drains stdin, exits
// 0 silently and immediately. What this is for: proving the timing
// measurement passes a healthy relay. What it must not do: touch the
// network — the conformance measurement owns the stub daemon, this file only
// exits fast.

let drained = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  drained += chunk;
});
process.stdin.on("end", () => {
  void drained;
  process.exitCode = 0;
});
process.stdin.on("error", () => {
  process.exitCode = 0;
});
