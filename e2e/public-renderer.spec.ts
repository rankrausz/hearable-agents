// Checks the shipped renderer surface; private development routes must not reappear in a public build.
import { expect, test } from "@playwright/test";

for (const hash of ["", "#lab", "#sandbox"]) {
  test(`the public audio host has no developer controls at ${hash || "root"}`, async ({ page }) => {
    await page.goto(`http://127.0.0.1:4173/${hash}`);
    await expect(page.getByRole("heading", { name: "Hearable", exact: true })).toBeVisible();
    await expect(page.getByRole("button")).toHaveCount(0);
    await expect(page.getByText("Sound lab", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText("Audio is off");
  });
}

test("the browser popover omits native and developer controls", async ({ page }) => {
  await page.goto("http://127.0.0.1:4173/?view=popover");
  await expect(page.getByRole("slider", { name: "Calm", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open console" })).toHaveCount(0);
  await expect(page.getByRole("slider", { name: "Volume", exact: true })).toHaveCount(0);
});
