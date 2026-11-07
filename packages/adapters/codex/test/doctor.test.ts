// packages/adapters/codex/test/doctor.test.ts — behaviour tests for the
// Codex doctor: platform, version, feature flag, install state, trust and
// edit-visibility checks each report honestly, with plain-language fixes
// and no invented capabilities.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctorCodex } from "../src/doctor.js";

async function throwawayHome(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-doctor-"));
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(dir, name), text, "utf8");
  }
  return dir;
}

describe("the Codex doctor", () => {
  it("reports a healthy install with the trust and edit-visibility warnings", async () => {
    const home = await throwawayHome({
      "hooks.json": JSON.stringify({ hooks: { Stop: [] }, note: "hearable-hook --agent codex" }),
    });
    const findings = await doctorCodex({ codexHome: home, platform: "darwin" });
    const bySeverity = findings.map((finding) => finding.severity);
    expect(bySeverity).toContain("ok");
    expect(bySeverity).toContain("warn");
    expect(findings.some((finding) => finding.message.includes("trust review"))).toBe(true);
    expect(
      findings.some(
        (finding) =>
          finding.severity === "ok" &&
          finding.message.includes("SessionEnd is advisory") &&
          finding.message.includes("idle timeout"),
      ),
    ).toBe(true);
    expect(findings.some((finding) => finding.message.includes("editEvents"))).toBe(true);
    for (const finding of findings) {
      if (finding.severity !== "ok") {
        expect(finding.fix?.length).toBeGreaterThan(0);
      }
    }
  });

  it("labels the documented-shape capabilities as assumptions with a fix", async () => {
    const home = await throwawayHome({
      "hooks.json": JSON.stringify({ hooks: { Stop: [] }, note: "hearable-hook --agent codex" }),
    });
    const findings = await doctorCodex({ codexHome: home, platform: "darwin" });
    const assumed = findings.find((finding) =>
      finding.message.includes("assumed until live Codex tool traffic verifies them"),
    );
    expect(assumed).toBeDefined();
    expect(assumed?.severity).toBe("warn");
    expect(assumed?.fix?.length).toBeGreaterThan(0);
  });

  it("fails when the hooks feature flag is off", async () => {
    const home = await throwawayHome({ "config.toml": "[features]\nhooks = false\n" });
    const findings = await doctorCodex({ codexHome: home, platform: "darwin" });
    const failed = findings.filter((finding) => finding.severity === "fail");
    expect(failed.some((finding) => finding.message.includes("turned off"))).toBe(true);
  });

  it("fails on Windows, where Codex hooks are disabled", async () => {
    const home = await throwawayHome({});
    const findings = await doctorCodex({ codexHome: home, platform: "win32" });
    expect(findings.some((finding) => finding.severity === "fail")).toBe(true);
  });

  it("warns when the hooks are not installed", async () => {
    const home = await throwawayHome({ "hooks.json": JSON.stringify({ hooks: {} }) });
    const findings = await doctorCodex({ codexHome: home, platform: "darwin" });
    expect(
      findings.some(
        (finding) => finding.severity === "fail" && finding.message.includes("not installed"),
      ),
    ).toBe(true);
  });
});
