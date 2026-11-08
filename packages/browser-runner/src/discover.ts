import type { Page } from "playwright";

export type DiscoveredControl = {
  selector: string;
  tag: string;
  type: string;
  name: string;
  label: string;
  required: boolean;
};

export type DiscoveredForm = {
  controls: DiscoveredControl[];
  submitCandidates: { selector: string; text: string }[];
  consentCandidates: { selector: string; label: string }[];
  formCount: number;
};

export async function discoverForm(page: Page): Promise<DiscoveredForm> {
  return page.evaluate(() => {
    const css = (value: string) => CSS.escape(value);
    const selectorFor = (element: Element): string => {
      if (element.id) return `#${css(element.id)}`;
      const name = element.getAttribute("name");
      if (name) return `${element.tagName.toLowerCase()}[name="${name.replace(/"/g, '\\"')}"]`;
      return element.tagName.toLowerCase();
    };
    const labelFor = (element: HTMLElement): string => {
      const aria = element.getAttribute("aria-label");
      if (aria) return aria;
      const labels = (element as HTMLInputElement).labels;
      if (labels?.[0]?.textContent) return labels[0].textContent.trim();
      return element.getAttribute("placeholder") ?? "";
    };
    const scope = document.querySelector("form") ?? document.body;
    const inputs = Array.from(scope.querySelectorAll<HTMLInputElement>("input, textarea, select")).filter(
      (element) => element.type !== "hidden" && element.type !== "submit" && element.type !== "button",
    );
    const checkboxes = inputs.filter((element) => element.type === "checkbox");
    const controls = inputs
      .filter((element) => element.type !== "checkbox")
      .map((element) => ({
        selector: selectorFor(element),
        tag: element.tagName.toLowerCase(),
        type: element.type,
        name: element.name,
        label: labelFor(element).slice(0, 120),
        required: element.required,
      }));
    const submits = Array.from(
      scope.querySelectorAll<HTMLElement>('button[type="submit"], input[type="submit"], button:not([type])'),
    ).map((element) => ({
      selector: element.id
        ? `#${css(element.id)}`
        : element.tagName === "INPUT"
          ? 'input[type="submit"]'
          : `${scope === document.body ? "" : "form "}button${element.getAttribute("type") === "submit" ? '[type="submit"]' : ""}`,
      text: (element.textContent ?? (element as HTMLInputElement).value ?? "").trim().slice(0, 80),
    }));
    return {
      controls,
      submitCandidates: submits,
      consentCandidates: checkboxes.map((element) => ({ selector: selectorFor(element), label: labelFor(element).slice(0, 160) })),
      formCount: document.querySelectorAll("form").length,
    };
  });
}
