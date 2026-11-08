export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export type ButtonVariant = "primary" | "secondary" | "tertiary" | "danger";

const BUTTON_BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-button px-[18px] text-sm font-semibold leading-[1.2] tracking-[-0.005em] transition-colors duration-[120ms] ease-out disabled:opacity-55 aria-disabled:opacity-55";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-ink text-white hover:bg-ink-2",
  secondary: "border border-line-control bg-canvas text-ink hover:bg-subtle",
  tertiary: "px-2 text-ink underline decoration-line-control underline-offset-4 hover:decoration-ink",
  danger: "border border-danger bg-canvas text-danger hover:bg-subtle",
};

export function buttonClass(variant: ButtonVariant = "primary", className?: string): string {
  return cx(BUTTON_BASE, BUTTON_VARIANTS[variant], className);
}
