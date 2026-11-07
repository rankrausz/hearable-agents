// Identifies pages by their daemon URL; must not depend on the order Chromium finishes loading them.
import { type ElectronApplication, expect } from "@playwright/test";
export async function consolePage(shell: ElectronApplication) {
  await expect
    .poll(() =>
      shell
        .windows()
        .some((page) => page.url().startsWith("http") && !page.url().includes("view=popover")),
    )
    .toBe(true);
  const page = shell
    .windows()
    .find((page) => page.url().startsWith("http") && !page.url().includes("view=popover"));
  if (!page) throw new Error("The console did not load");
  return page;
}
