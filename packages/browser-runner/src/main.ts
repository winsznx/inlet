import { createInterface } from "node:readline";
import { chromium, type BrowserContext, type Page, type Request } from "playwright";
import { browserJobSchema, runnerMessageSchema } from "@inlet/domain";
import type { BrowserJob, BrowserOutcome, FieldMap, NetworkSummary, RunnerArtifact, RunnerMessage } from "@inlet/domain";
import { discoverForm } from "./discover";

const SUBMIT_ACK_TIMEOUT_MS = 15_000;
const SUCCESS_WAIT_MS = 8_000;
const CAPTCHA_FRAME = /recaptcha|hcaptcha|turnstile|arkoselabs/i;
const SUCCESS_TEXT = /thank|sent|received|success|submitted|we'?ll be in touch/i;

function emit(message: RunnerMessage): void {
  process.stdout.write(`${JSON.stringify(runnerMessageSchema.parse(message))}\n`);
}

function stage(name: "opening_form" | "mapping_fields" | "submitting"): void {
  emit({ t: "stage", stage: name, at: new Date().toISOString() });
}

function artifact(kind: RunnerArtifact["kind"], name: string, mime: RunnerArtifact["mime"], data: Buffer | string): void {
  emit({ t: "artifact", kind, name, mime, b64: Buffer.from(data).toString("base64") });
}

const stdinLines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();

async function nextLine(timeoutMs?: number): Promise<string | null> {
  const read = stdinLines.next().then((item) => (item.done ? null : item.value));
  if (!timeoutMs) return read;
  return Promise.race([read, new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))]);
}

function emptyOutcome(): BrowserOutcome {
  return {
    t: "result",
    navigated: false,
    httpStatus: null,
    fieldsFilled: false,
    submitClicked: false,
    submitObserved: false,
    successUiObserved: false,
    successUiText: null,
    captchaDetected: false,
    failure: null,
    failureDetail: null,
    network: [],
  };
}

function trimUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`.slice(0, 400);
  } catch {
    return "invalid";
  }
}

function trackNetwork(page: Page): { entries: NetworkSummary[]; afterSubmit: () => boolean; markSubmit: () => void } {
  const entries: NetworkSummary[] = [];
  let submitAt = Number.POSITIVE_INFINITY;
  let mutated = false;
  const note = (request: Request, status: number | null, failed: boolean) => {
    if (entries.length < 200) entries.push({ method: request.method(), url: trimUrl(request.url()), status, failed });
  };
  page.on("request", (request) => {
    if (Date.now() >= submitAt && (request.method() !== "GET" || request.isNavigationRequest())) mutated = true;
  });
  page.on("requestfinished", async (request) => {
    const response = await request.response().catch(() => null);
    note(request, response?.status() ?? null, false);
  });
  page.on("requestfailed", (request) => note(request, null, true));
  return {
    entries,
    afterSubmit: () => mutated,
    markSubmit: () => {
      submitAt = Date.now();
    },
  };
}

async function screenshot(page: Page, kind: RunnerArtifact["kind"], name: string): Promise<void> {
  const image = await page.screenshot({ fullPage: true, type: "png", timeout: 8_000 }).catch(() => null);
  if (image) artifact(kind, name, "image/png", image);
}

async function hasCaptcha(page: Page): Promise<boolean> {
  return page.frames().some((frame) => CAPTCHA_FRAME.test(frame.url()));
}

async function launch(job: BrowserJob): Promise<{ context: BrowserContext; close: () => Promise<void> }> {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking", "--disable-component-update"],
    proxy: job.proxyServer ? { server: job.proxyServer, bypass: "<-loopback>" } : undefined,
  });
  const context = await browser.newContext({
    acceptDownloads: false,
    serviceWorkers: "block",
    viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: { "X-Inlet-Test": "1" },
    userAgent: "Mozilla/5.0 (compatible; InletTest/1.0; +synthetic-enquiry-check)",
  });
  return {
    context,
    close: async () => {
      await browser.close().catch(() => undefined);
    },
  };
}

async function openForm(page: Page, job: BrowserJob, outcome: BrowserOutcome): Promise<boolean> {
  try {
    const response = await page.goto(job.targetUrl, { waitUntil: "load", timeout: job.navigationTimeoutMs });
    outcome.httpStatus = response?.status() ?? null;
    outcome.navigated = Boolean(response?.ok());
    if (!response?.ok()) {
      outcome.failure = response?.status() === 403 ? "blocked_by_policy" : "navigation_failed";
      outcome.failureDetail = `The page responded with status ${response?.status() ?? "unknown"}.`;
      return false;
    }
    return true;
  } catch (error) {
    outcome.failure = "navigation_failed";
    outcome.failureDetail = error instanceof Error ? error.message.split("\n")[0]?.slice(0, 380) ?? null : null;
    return false;
  }
}

async function fillFields(page: Page, map: FieldMap, job: BrowserJob, outcome: BrowserOutcome): Promise<boolean> {
  const identity = job.identity;
  const token = job.token;
  if (!identity || !token) {
    outcome.failure = "unexpected_error";
    outcome.failureDetail = "The run was missing its synthetic identity or token.";
    return false;
  }
  const values: [string, string][] = [
    [map.name, identity.name],
    [map.email, identity.email],
    ...(map.subject ? ([[map.subject, `${identity.subject} ${token}`]] as [string, string][]) : []),
    [map.message, `${identity.messagePrefix}\n\nReference: ${token}`],
  ];
  for (const [selector, value] of values) {
    const locator = page.locator(selector);
    const matches = await locator.count();
    if (matches === 0) {
      outcome.failure = "field_not_found";
      outcome.failureDetail = `No element matched the selector ${selector}.`;
      return false;
    }
    if (matches > 1) {
      outcome.failure = "ambiguous_fields";
      outcome.failureDetail = `${matches} elements matched the selector ${selector}.`;
      return false;
    }
    await locator.fill(value, { timeout: 5_000 });
  }
  if (map.consent) await page.locator(map.consent).check({ timeout: 3_000 });
  outcome.fieldsFilled = true;
  return true;
}

async function detectSuccessUi(page: Page, map: FieldMap): Promise<string | null> {
  if (map.successIndicator) {
    const locator = page.locator(map.successIndicator).first();
    const visible = await locator
      .waitFor({ state: "visible", timeout: SUCCESS_WAIT_MS })
      .then(() => true)
      .catch(() => false);
    if (visible) return ((await locator.textContent().catch(() => "")) ?? "").trim().slice(0, 240);
    return null;
  }
  const deadline = Date.now() + SUCCESS_WAIT_MS;
  while (Date.now() < deadline) {
    const texts = await page.locator('[role="status"], [role="alert"], .success, .notice').allTextContents().catch(() => []);
    const match = texts.map((text) => text.trim()).find((text) => SUCCESS_TEXT.test(text));
    if (match) return match.slice(0, 240);
    await page.waitForTimeout(200);
  }
  return null;
}

async function runSubmit(job: BrowserJob): Promise<BrowserOutcome> {
  const outcome = emptyOutcome();
  const map = job.fieldMap;
  if (!map) {
    outcome.failure = "unexpected_error";
    outcome.failureDetail = "The run was missing its field mapping.";
    return outcome;
  }
  const { context, close } = await launch(job);
  const page = await context.newPage();
  const consoleLines: string[] = [];
  page.on("console", (message) => {
    if (consoleLines.length < 200) consoleLines.push(`[${message.type()}] ${message.text().slice(0, 300)}`);
  });
  page.on("pageerror", (error) => {
    if (consoleLines.length < 200) consoleLines.push(`[pageerror] ${error.message.slice(0, 300)}`);
  });
  const network = trackNetwork(page);
  try {
    stage("opening_form");
    if (!(await openForm(page, job, outcome))) return outcome;

    if (await hasCaptcha(page)) {
      outcome.captchaDetected = true;
      outcome.failure = "captcha_detected";
      outcome.failureDetail = "A CAPTCHA protects this form. Inlet does not attempt to bypass it.";
      return outcome;
    }

    stage("mapping_fields");
    if (!(await fillFields(page, map, job, outcome))) return outcome;
    await screenshot(page, "screenshot-before", "form-filled.png");

    const submit = page.locator(map.submit);
    if ((await submit.count()) !== 1) {
      outcome.failure = "submit_not_found";
      outcome.failureDetail = `Expected one submit control for ${map.submit}.`;
      return outcome;
    }

    emit({ t: "submit_request", at: new Date().toISOString() });
    const ack = await nextLine(SUBMIT_ACK_TIMEOUT_MS);
    if (!ack || (JSON.parse(ack) as { go?: boolean }).go !== true) {
      outcome.failure = "unexpected_error";
      outcome.failureDetail = "The controller did not authorize the submission.";
      return outcome;
    }

    stage("submitting");
    network.markSubmit();
    await submit.click({ timeout: 5_000 });
    outcome.submitClicked = true;
    const successText = await detectSuccessUi(page, map);
    outcome.successUiObserved = successText !== null;
    outcome.successUiText = successText;
    await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
    outcome.submitObserved = network.afterSubmit();
    await screenshot(page, "screenshot-after", "after-submit.png");
    return outcome;
  } catch (error) {
    outcome.failure = outcome.submitClicked ? "submit_failed" : "unexpected_error";
    outcome.failureDetail = error instanceof Error ? error.message.split("\n")[0]?.slice(0, 380) ?? null : null;
    return outcome;
  } finally {
    outcome.network = network.entries;
    artifact("network-log", "network.json", "application/json", JSON.stringify(network.entries, null, 2));
    artifact("console-log", "console.txt", "text/plain", consoleLines.join("\n"));
    await close();
  }
}

async function runDiscover(job: BrowserJob): Promise<BrowserOutcome> {
  const outcome = emptyOutcome();
  const { context, close } = await launch(job);
  const page = await context.newPage();
  try {
    stage("opening_form");
    if (!(await openForm(page, job, outcome))) return outcome;
    outcome.captchaDetected = await hasCaptcha(page);
    stage("mapping_fields");
    outcome.discovered = await discoverForm(page);
    await screenshot(page, "screenshot-before", "form.png");
    return outcome;
  } catch (error) {
    outcome.failure = "unexpected_error";
    outcome.failureDetail = error instanceof Error ? error.message.slice(0, 380) : null;
    return outcome;
  } finally {
    await close();
  }
}

async function runContainment(job: BrowserJob): Promise<BrowserOutcome> {
  const outcome = emptyOutcome();
  outcome.containment = [];
  const { context, close } = await launch(job);
  const page = await context.newPage();
  const network = trackNetwork(page);
  try {
    stage("opening_form");
    if (!(await openForm(page, job, outcome))) return outcome;
    await screenshot(page, "screenshot-before", "attack-page.png");
    await page.waitForTimeout(1_500);

    stage("mapping_fields");
    const injectedTarget =
      job.containment?.attemptNavigation ??
      (await page.locator("[data-inlet-attack-target]").first().getAttribute("data-inlet-attack-target").catch(() => null));

    if (injectedTarget) {
      const attempt = await page
        .context()
        .newPage()
        .then(async (attackTab) => {
          try {
            const response = await attackTab.goto(injectedTarget, { timeout: 8_000 });
            const status = response?.status() ?? 0;
            return status === 403
              ? { outcome: "denied" as const, detail: "The egress gateway answered 403.", exitStatus: "HTTP 403" }
              : { outcome: "allowed" as const, detail: `Navigation returned status ${status}.`, exitStatus: `HTTP ${status}` };
          } catch (error) {
            const message = error instanceof Error ? (error.message.split("\n")[0] ?? "") : "";
            return { outcome: "denied" as const, detail: message.slice(0, 300), exitStatus: "navigation error" };
          } finally {
            await attackTab.close().catch(() => undefined);
          }
        });
      outcome.containment.push({
        probe: "follow-injected-instruction",
        attempted: `Navigate to the address injected by the page (${trimUrl(injectedTarget)})`,
        ...attempt,
      });
    }

    const pageAttempts = await page.evaluate(() => (window as unknown as { __attack?: { kind: string; outcome: string }[] }).__attack ?? []);
    for (const item of pageAttempts) {
      outcome.containment.push({
        probe: `page-${item.kind}`,
        attempted: `Page script used ${item.kind} toward the unapproved host`,
        outcome: item.outcome === "failed" || item.outcome === "threw" ? "denied" : "allowed",
        detail: `Browser reported: ${item.outcome}`,
      });
    }
    await screenshot(page, "screenshot-after", "attack-page-after.png");
    return outcome;
  } catch (error) {
    outcome.failure = "unexpected_error";
    outcome.failureDetail = error instanceof Error ? error.message.slice(0, 380) : null;
    return outcome;
  } finally {
    outcome.network = network.entries;
    await close();
  }
}

async function main(): Promise<void> {
  const firstLine = await nextLine();
  if (!firstLine) process.exit(2);
  const job = browserJobSchema.parse(JSON.parse(firstLine));
  const handlers = { submit: runSubmit, discover: runDiscover, containment: runContainment };
  emit(await handlers[job.mode](job));
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
