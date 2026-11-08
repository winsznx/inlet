import { expect, test } from "@playwright/test";

const SHOTS = "../.local-artifacts/qa/screens";

test("public demo runs a real check in the browser", async ({ page }) => {
  // #given
  await page.goto("/demo");
  // #when
  await page.getByRole("button", { name: "Run test" }).click();
  // #then
  await expect(page.getByRole("heading", { name: "Enquiry received" })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("Controlled test environment").first()).toBeVisible();
  await page.getByRole("img", { name: "Page after submission" }).first().waitFor();
  await page.screenshot({ path: `${SHOTS}/demo-received-1440.png`, fullPage: true });
});

test("public demo shows the blocked action", async ({ page }) => {
  // #given
  await page.goto("/demo");
  await page.getByRole("radio", { name: /Blocked action/ }).check();
  // #when
  await page.getByRole("button", { name: "Run test" }).click();
  // #then
  await expect(page.getByRole("heading", { name: "Unauthorized action blocked" })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(/Blocked a request outside the approved website/).first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/demo-blocked-1440.png`, fullPage: true });
});

test("sandbox lab runs a containment test from its button", async ({ page }) => {
  // #given
  await page.goto("/login");
  await page.getByLabel("Email address").fill("dev@inlet.test");
  await page.getByLabel("Password", { exact: true }).fill("inlet-local-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/app\//);
  await page.goto("/app/sandbox-lab");
  // #when
  await page.getByRole("button", { name: "Run test" }).first().click();
  // #then
  await expect(page.getByRole("heading", { name: "Unauthorized action blocked" })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("Removal verified")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/lab-blocked-1440.png`, fullPage: true });
});
