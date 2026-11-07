// packages/adapters/claude-code/src/error-class.ts — the coarse errorClass
// for PostToolUseFailure payloads. What this is for: turning the free-text
// `error` string into the coarse vocabulary docs/EVENTS.md §Shape allows
// (`test_failure`, `compile_error`, `not_found`, `timeout`, `other`) without
// recording the text itself. What it must not do: parse output for evidence
// beyond classification — the classifier owns tool semantics, this module
// owns only the coarse failure label.

/**
 * Classifies a tool failure message coarsely. Keys on stable signals (the
 * `Exit code N` first line the hooks reference documents, timeout markers,
 * compiler/test/not-found phrases) and returns "other" for anything else,
 * including absent input — an unrecognised failure is still a failure.
 */
export function errorClassFor(message: string | null): string {
  if (message === null) {
    return "other";
  }
  const text = message.toLowerCase();
  if (
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("command timed out") ||
    text.includes("etimedout")
  ) {
    return "timeout";
  }
  if (
    text.includes("cannot find module") ||
    text.includes("command not found") ||
    text.includes("no such file") ||
    text.includes("not found:") ||
    text.includes("enoent")
  ) {
    return "not_found";
  }
  if (
    text.includes("test failed") ||
    text.includes("tests failed") ||
    text.includes("failing") ||
    text.includes("assertionerror") ||
    text.includes("expect(") ||
    /\b\d+\s+(failed|failing)\b/.test(text)
  ) {
    return "test_failure";
  }
  if (
    text.includes("compile error") ||
    text.includes("compilation error") ||
    text.includes("syntaxerror") ||
    text.includes("type error") ||
    text.includes("tsc ") ||
    text.includes("error ts")
  ) {
    return "compile_error";
  }
  return "other";
}
