import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const PASSWORD = "correct-horse-battery";
const WIDTHS = [1440, 1024, 768, 390, 320];
const SHOTS = "../.local-artifacts/qa/screens";

async function inspectState(page: Page, name: string): Promise<void> {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${name} overflows at ${width}`).toBeLessThanOrEqual(0);
    if (width === 1440 || width === 390) {
      await page.screenshot({ path: `${SHOTS}/${name}-${width}.png`, fullPage: true });
      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      expect(axe.violations.map((item) => `${item.id}: ${item.nodes[0]?.target}`), `${name} at ${width}`).toEqual([]);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function register(page: Page, email: string): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("Your name").fill("Lifecycle Tester");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Start with a workspace" })).toBeVisible();
  await page.getByLabel("Workspace name").fill("Lifecycle Agency");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByRole("heading", { name: "No websites connected" })).toBeVisible({ timeout: 30_000 });
}

async function addSampleSite(page: Page, buttonName: string, withRepository: boolean): Promise<void> {
  await page.goto("/app/sites/new");
  await page.getByRole("button", { name: buttonName }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Delivery destination" })).toBeVisible();
  await page.getByRole("button", { name: "Connect and test" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Form and code" })).toBeVisible();
  await page.getByRole("button", { name: "Detect fields" }).click();
  await page.getByRole("button", { name: "Use proposed mapping" }).click({ timeout: 90_000 });
  await page.getByLabel("Success message (optional)").fill("#form-success");
  await page.getByRole("button", { name: "Save mapping" }).click();
  await expect(page.getByText("Field mapping saved.")).toBeVisible();
  if (withRepository) {
    await page.getByRole("button", { name: "Connect sample repository" }).click();
    await expect(page.getByText("fixtures/enquiry-site")).toBeVisible({ timeout: 30_000 });
  }
  await page.getByRole("button", { name: "Save website and run check" }).click();
  await page.waitForURL(/\/app\/runs\//);
}

test("connect, test, detect, investigate, repair, approve, retest, verify", async ({ page, request }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("Failed to load resource")) consoleErrors.push(message.text());
  });
  await register(page, `lifecycle-${Date.now()}@inlet.test`);

  await addSampleSite(page, "Acme Demo (working form)", false);
  await expect(page.getByRole("heading", { name: "Enquiry received" })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText("The form displayed a success message.").first()).toBeVisible();
  await expect(page.getByText("Matching message found", { exact: true })).toBeVisible();
  await inspectState(page, "run-received");

  const token = (await page.locator("code", { hasText: "INLET-TEST-" }).first().innerText()).trim();
  expect(token).toMatch(/^INLET-TEST-[0-9a-f]{32}$/);
  const mailbox = await request.get(`http://localhost:8025/api/v1/search?query=${encodeURIComponent(`"${token}"`)}`);
  expect((await mailbox.json()).messages_count).toBeGreaterThanOrEqual(1);

  await addSampleSite(page, "Acme Demo (missing notification)", true);
  await expect(page.getByRole("heading", { name: "Enquiry not received" })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("The form displayed a success message.").first()).toBeVisible();
  await expect(page.getByText(/No matching message arrived in the connected test inbox during the 30-second observation window/).first()).toBeVisible();

  await inspectState(page, "run-not-received");
  await page.getByRole("link", { name: "View incident" }).click({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Form submitted. Enquiry not received." })).toBeVisible();
  await inspectState(page, "incident-open");

  const useModel = await page.getByRole("button", { name: "Investigate code" }).isVisible();
  await page.getByRole("button", { name: useModel ? "Investigate code" : "Run non-AI test harness" }).click();
  await expect(page.getByRole("link", { name: "Review tested patch" })).toBeVisible({ timeout: 520_000 });
  if (!useModel) await expect(page.getByText("Non-AI test harness", { exact: true })).toBeVisible();
  await inspectState(page, "incident-patch-ready");
  await page.getByRole("link", { name: "Review tested patch" }).click();

  await expect(page.getByRole("heading", { name: "Tested patch ready" })).toBeVisible();
  await inspectState(page, "patch-review");
  await expect(page.getByText("ENQUIRY_NOTIFY_ADDRESS", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByLabel("Reason").fill("Reviewed the diff and checks.");
  await page.getByLabel("I reviewed the diff, the checks and the risk notes.").check();
  await page.getByRole("button", { name: "Approve", exact: true }).last().click();
  await expect(page.getByText("Patch approved. It still has to be deployed.")).toBeVisible();

  await page.getByRole("link", { name: "Back to the incident" }).click();
  await expect(page.getByText("Awaiting deployment").first()).toBeVisible();
  await page.getByRole("button", { name: "Apply approved fixture change" }).click();
  await page.getByLabel("I understand this deploys the approved patch to the test site.").check();
  await page.getByRole("button", { name: "Apply change" }).click();
  await expect(page.getByRole("button", { name: "Recheck after deployment" })).toBeVisible({ timeout: 200_000 });
  await inspectState(page, "incident-awaiting-deployment");
  await page.getByRole("button", { name: "Recheck after deployment" }).click();
  await page.waitForURL(/\/app\/runs\//);
  await expect(page.getByRole("heading", { name: "Enquiry received" })).toBeVisible({ timeout: 120_000 });
  await page.goto("/app/incidents");
  await expect(page.getByText("Verified recovered")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("link", { name: /Form submitted, enquiry not received/ }).click();
  await expect(page.getByRole("heading", { name: "Form submitted. Enquiry not received." })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("A new test enquiry was found in the destination after deployment.")).toBeVisible();
  await inspectState(page, "incident-verified-recovered");
  expect(consoleErrors).toEqual([]);
});
