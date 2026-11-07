// packages/adapter-kit/test/fixtures/slow-relay.mjs — a deliberately slow
// stub relay for the relay-timing negative control: drains stdin, then waits
// well past any test budget before exiting 0 silently. What this is for:
// proving the timing measurement fails a relay that exceeds its budget — the
// kept negative control the task verification demands. What it must not do:
// anything but wait — it must still exit 0 silently, so the failure under
// test is the budget, never the exit contract.

await new Promise((resolve) => {
  let finished = false;
  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    resolve(undefined);
  };
  process.stdin.resume();
  process.stdin.on("end", finish);
  process.stdin.on("error", finish);
  setTimeout(finish, 100).unref();
});

await new Promise((resolve) => setTimeout(resolve, 1200));
process.exitCode = 0;
