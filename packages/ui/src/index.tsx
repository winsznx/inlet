"use client";

import { AlertTriangle, Check, CheckCircle2, ChevronDown, CircleDashed, Clock, Copy, Loader2, ShieldX, X, XCircle } from "lucide-react";
import { Accordion as AccordionPrimitive, Dialog as DialogPrimitive, Tabs as TabsPrimitive, Tooltip as TooltipPrimitive } from "radix-ui";
import { createContext, forwardRef, useCallback, useContext, useId, useMemo, useRef, useState } from "react";
import { buttonClass, cx } from "./classes";
import type { ButtonVariant } from "./classes";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactElement, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

export { buttonClass, cx };
export type { ButtonVariant };

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "primary", loading, className, children, disabled, type, ...rest }, ref) {
  return (
    <button ref={ref} type={type ?? "button"} className={buttonClass(variant, className)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Loader2 size={16} className="animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
});

const CONTROL = "w-full min-h-11 rounded-input border border-line-control bg-canvas px-3 text-[15px] text-ink placeholder:text-faint aria-invalid:border-danger disabled:bg-subtle disabled:text-muted";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(CONTROL, className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(CONTROL, "py-2.5", className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cx(CONTROL, className)} {...rest}>
      {children}
    </select>
  );
});

type ControlRenderProps = { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean };

export function Field({ label, help, error, children }: { label: string; help?: ReactNode; error?: string | null; children: (control: ControlRenderProps) => ReactElement }) {
  const id = useId();
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, helpId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {error ? (
        <p id={errorId} className="text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      {help ? (
        <p id={helpId} className="text-[13px] text-muted">
          {help}
        </p>
      ) : null}
    </div>
  );
}

export function Checkbox({ label, description, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; description?: ReactNode }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-11 w-5 shrink-0 items-start justify-center pt-0.5">
        <input id={id} type="checkbox" className="size-[18px] accent-[var(--graphite-950)]" {...rest} />
      </span>
      <label htmlFor={id} className="min-h-11 pt-px text-sm text-ink">
        {label}
        {description ? <span className="mt-0.5 block text-[13px] text-muted">{description}</span> : null}
      </label>
    </div>
  );
}

export function Panel({ children, className, title, action }: { children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode }) {
  return (
    <section className={cx("min-w-0 rounded-panel border border-line bg-canvas", className)}>
      {title ? (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line-subtle px-5 py-3.5">
          <h2 className="t-section">{title}</h2>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export type StatusTone = "success" | "danger" | "warning" | "neutral" | "running";

const TONE_COLOR: Record<StatusTone, string> = {
  success: "text-success",
  danger: "text-danger",
  warning: "text-warning",
  neutral: "text-muted",
  running: "text-ink-2",
};

const TONE_ICON: Record<StatusTone, typeof Check> = {
  success: CheckCircle2,
  danger: XCircle,
  warning: AlertTriangle,
  neutral: CircleDashed,
  running: Loader2,
};

export function Status({ tone, children, className, icon }: { tone: StatusTone; children: ReactNode; className?: string; icon?: "blocked" | "pending" }) {
  const Icon = icon === "blocked" ? ShieldX : icon === "pending" ? Clock : TONE_ICON[tone];
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-sm font-medium", TONE_COLOR[tone], className)}>
      <Icon size={16} aria-hidden className={cx("shrink-0", tone === "running" && "animate-spin")} />
      <span>{children}</span>
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton", className)} aria-hidden />;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="px-6 py-14 text-center">
      <h2 className="t-section">{title}</h2>
      {children ? <p className="mx-auto mt-2 max-w-[52ch] text-[15px] text-muted">{children}</p> : null}
      {action ? <div className="mt-5 flex justify-center gap-3">{action}</div> : null}
    </div>
  );
}

export function Notice({ tone = "neutral", title, children, action }: { tone?: "neutral" | "danger" | "warning" | "success"; title?: string; children?: ReactNode; action?: ReactNode }) {
  const toneClass = { neutral: "border-line bg-subtle", danger: "border-danger", warning: "border-warning", success: "border-success" }[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cx("flex flex-wrap items-start justify-between gap-3 rounded-panel border px-4 py-3", toneClass)}>
      <div className="min-w-0 flex-1 basis-60">
        {title ? <p className="text-sm font-semibold">{title}</p> : null}
        {children ? <div className="text-sm text-ink-2">{children}</div> : null}
      </div>
      {action}
    </div>
  );
}

export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copy = useCallback(async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  }, [value]);
  return (
    <button type="button" onClick={() => void copy()} className={cx("inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-button px-2 text-[13px] font-medium text-ink-2 hover:bg-subtle", className)}>
      {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </button>
  );
}

export function Dialog({ open, onOpenChange, title, description, children, footer }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: ReactNode; children?: ReactNode; footer?: ReactNode }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-ink/40" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100vw-32px)] max-w-[480px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-dialog bg-raised p-6 shadow-elevated">
          <div className="flex items-start justify-between gap-3">
            <DialogPrimitive.Title className="t-section">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close aria-label="Close" className="-mr-2 -mt-2 inline-flex size-11 items-center justify-center rounded-button text-muted hover:bg-subtle">
              <X size={18} aria-hidden />
            </DialogPrimitive.Close>
          </div>
          {description ? <DialogPrimitive.Description className="mt-1 text-sm text-muted">{description}</DialogPrimitive.Description> : <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>}
          {children ? <div className="mt-4 grid gap-4">{children}</div> : null}
          {footer ? <div className="mt-6 flex flex-wrap justify-end gap-3">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Drawer({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-ink/40" />
        <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 flex w-[300px] max-w-[85vw] flex-col overflow-y-auto bg-raised">
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
          <DialogPrimitive.Close aria-label="Close menu" className="absolute right-2 top-2 inline-flex size-11 items-center justify-center rounded-button text-muted hover:bg-subtle">
            <X size={18} aria-hidden />
          </DialogPrimitive.Close>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Tabs({ value, onValueChange, label, items, className }: { value?: string; onValueChange?: (value: string) => void; label: string; items: { value: string; label: string; content: ReactNode }[]; className?: string }) {
  return (
    <TabsPrimitive.Root value={value} onValueChange={onValueChange} defaultValue={value ? undefined : items[0]?.value} className={className}>
      <TabsPrimitive.List aria-label={label} className="flex gap-1 overflow-x-auto border-b border-line">
        {items.map((item) => (
          <TabsPrimitive.Trigger key={item.value} value={item.value} className="min-h-11 shrink-0 border-b-2 border-transparent px-3 text-sm font-medium text-muted hover:text-ink data-[state=active]:border-copper data-[state=active]:text-ink">
            {item.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {items.map((item) => (
        <TabsPrimitive.Content key={item.value} value={item.value} className="pt-4">
          {item.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}

export function Accordion({ items }: { items: { id: string; title: string; content: ReactNode }[] }) {
  return (
    <AccordionPrimitive.Root type="multiple" className="border-t border-line">
      {items.map((item) => (
        <AccordionPrimitive.Item key={item.id} value={item.id} className="border-b border-line">
          <AccordionPrimitive.Header>
            <AccordionPrimitive.Trigger className="group flex min-h-16 w-full items-center justify-between gap-4 py-4 text-left text-[17px] font-medium">
              {item.title}
              <ChevronDown size={18} aria-hidden className="shrink-0 text-muted transition-transform duration-[180ms] group-data-[state=open]:rotate-180" />
            </AccordionPrimitive.Trigger>
          </AccordionPrimitive.Header>
          <AccordionPrimitive.Content className="pb-5 pr-8 text-[15px] leading-relaxed text-ink-2">{item.content}</AccordionPrimitive.Content>
        </AccordionPrimitive.Item>
      ))}
    </AccordionPrimitive.Root>
  );
}

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({ label, children, side = "right" }: { label: string; children: ReactElement; side?: "right" | "top" | "bottom" | "left" }) {
  return (
    <TooltipPrimitive.Root delayDuration={150}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content side={side} sideOffset={6} className="z-50 rounded-status bg-ink px-2.5 py-1.5 text-xs font-medium text-white">
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

type Toast = { id: number; message: string; tone: "success" | "danger" };
const ToastContext = createContext<(message: string, tone?: Toast["tone"]) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  const push = useCallback((message: string, tone: Toast["tone"] = "success") => {
    counter.current += 1;
    const id = counter.current;
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 5000);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-end gap-2" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={cx("pointer-events-auto max-w-sm rounded-panel border bg-raised px-4 py-3 text-sm shadow-elevated", toast.tone === "danger" ? "border-danger text-danger" : "border-line text-ink")}>
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (message: string, tone?: Toast["tone"]) => void {
  return useContext(ToastContext);
}

export function DefinitionRows({ rows }: { rows: { term: string; value: ReactNode }[] }) {
  return (
    <dl className="divide-y divide-line-subtle">
      {rows.map((row) => (
        <div key={row.term} className="grid gap-0.5 px-5 py-2.5 sm:grid-cols-[minmax(120px,38%)_1fr] sm:gap-4">
          <dt className="text-[13px] text-muted">{row.term}</dt>
          <dd className="min-w-0 break-words text-sm text-ink">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
