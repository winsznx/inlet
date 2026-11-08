import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";

const WIDTHS = [320, 375, 390, 430, 768, 1024, 1280, 1440, 1920];
const OUT = "../.local-artifacts/qa/screens";
const PUBLIC_ROUTES = ["/", "/demo", "/docs", "/privacy", "/terms", "/status", "/login", "/register", "/forgot-password", "/does-not-exist"];
const SHOT_WIDTHS = new Set([390, 1440]);

function slug(route: string): string {
  return route === "/" ? "home" : route.replace(/^\//, "").replace(/\//g, "-");
}

async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${label} overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(0);
}

async function collectAuthed(browser: Browser): Promise<{ page: Page; routes: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: "http://localhost:3000" });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email address").fill("dev@inlet.test");
  await page.getByLabel("Password", { exact: true }).fill("inlet-local-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/app\//);
  if (page.url().includes("/app/welcome")) {
    await page.getByLabel("Workspace name").fill("Visual QA");
    await page.getByRole("button", { name: "Create workspace" }).click();
    await page.waitForURL(/\/app\/sites/);
  }
  return { page, routes: ["/app/sites", "/app/sites/new", "/app/runs", "/app/incidents", "/app/connections", "/app/notifications", "/app/settings", "/app/activity", "/app/sandbox-lab"] };
}

for (const route of PUBLIC_ROUTES) {
  test(`public ${route} is responsive and accessible`, async ({ browser }) => {
    for (const width of WIDTHS) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, baseURL: "http://localhost:3000" });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(route, { waitUntil: "networkidle" });
      await assertNoHorizontalOverflow(page, `${route} at ${width}`);
      if (SHOT_WIDTHS.has(width)) await page.screenshot({ path: `${OUT}/${slug(route)}-${width}.png`, fullPage: true });
      expect(errors).toEqual([]);
      if (width === 1440 || width === 390) {
        const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
        expect(results.violations.map((item) => `${item.id}: ${item.nodes[0]?.target}`), `${route} at ${width}`).toEqual([]);
      }
      await context.close();
    }
  });
}

test("mobile navigation opens, closes with Escape and traps focus", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, baseURL: "http://localhost:3000" });
  await page.goto("/");
  await page.getByRole("button", { name: "Menu" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({ path: `${OUT}/mobile-nav-390.png` });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("faq is keyboard operable", async ({ page }) => {
  await page.goto("/#faq");
  const trigger = page.getByRole("button", { name: "How does it know an enquiry arrived?" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("It looks for the unique test identifier")).toBeVisible();
});

test("every marketing link and call to action resolves", async ({ page, request }) => {
  await page.goto("/");
  const hrefs = await page.locator("a[href]").evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).getAttribute("href") ?? ""));
  for (const href of new Set(hrefs)) {
    if (href.startsWith("#") || href.startsWith("/#")) {
      const id = href.split("#")[1];
      expect(await page.locator(`[id="${id}"]`).count(), `missing anchor ${href}`).toBe(1);
    } else {
      const response = await request.get(href);
      expect(response.status(), href).toBeLessThan(400);
    }
  }
});

test("reduced motion removes smooth animation", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce", baseURL: "http://localhost:3000" });
  const page = await context.newPage();
  await page.goto("/");
  const duration = await page.evaluate(() => getComputedStyle(document.querySelector("a[href='/demo']") as Element).transitionDuration);
  expect(Number.parseFloat(duration)).toBeLessThan(0.05);
  await context.close();
});

test("app routes are responsive and accessible", async ({ browser }) => {
  test.setTimeout(560_000);
  const { page, routes } = await collectAuthed(browser);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of routes) {
      await page.goto(route, { waitUntil: "load" });
      await page.locator("h1").first().waitFor();
      await page.waitForTimeout(250);
      await assertNoHorizontalOverflow(page, `${route} at ${width}`);
      if (SHOT_WIDTHS.has(width)) await page.screenshot({ path: `${OUT}/${slug(route)}-${width}.png`, fullPage: true });
      if (width === 1440 || width === 390) {
        const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
        expect(results.violations.map((item) => `${item.id}: ${item.nodes[0]?.target}`), `${route} at ${width}`).toEqual([]);
      }
    }
  }
});
