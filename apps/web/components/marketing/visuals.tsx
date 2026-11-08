import { Status } from "@inlet/ui";
import type { ReactNode } from "react";

export function ExampleFrame({ title, label = "Example workflow", children, id }: { title: string; label?: string; children: ReactNode; id?: string }) {
  return (
    <figure id={id} className="overflow-hidden rounded-panel border border-line bg-canvas shadow-elevated">
      <figcaption className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-line-subtle bg-subtle px-4 py-2.5">
        <span className="min-w-0 break-words text-[13px] font-medium text-ink-2">{title}</span>
        <span className="t-meta text-warning">{label}</span>
      </figcaption>
      {children}
    </figure>
  );
}

const ROUTE_ROWS = [
  { title: "Browser submitted", detail: "The form said the enquiry was sent." },
  { title: "Checking inbox", detail: "Looking for this test's unique ID at the destination." },
  { title: "Receipt confirmed", detail: "The matching message was found in the connected inbox." },
];

export function HeroRoute() {
  return (
    <ExampleFrame title="Contact form — acme-demo.test" label="Sample environment. Example workflow">
      <div className="grid gap-0 p-5 sm:p-7">
        <svg viewBox="0 0 560 150" className="w-full" role="img" aria-label="Two routes, the website's response and the delivery check, converging on one confirmed receipt.">
          <path d="M6 28H330C392 28 430 54 430 104V112" fill="none" stroke="#15191B" strokeWidth="9" strokeLinecap="square" strokeLinejoin="round" />
          <path d="M6 82H262C318 82 352 100 352 132H392" fill="none" stroke="#15191B" strokeWidth="9" strokeLinecap="square" strokeLinejoin="round" />
          <rect x="398" y="112" width="36" height="36" rx="2" fill="#A5643C" />
          <text x="6" y="16" className="fill-[#596368] max-sm:hidden" fontSize="13" fontFamily="var(--font-plex)">What the website showed</text>
          <text x="6" y="70" className="fill-[#596368] max-sm:hidden" fontSize="13" fontFamily="var(--font-plex)">What the destination received</text>
          <text x="446" y="136" className="fill-[#15191B] max-sm:text-[22px]" fontSize="15" fontWeight="600" fontFamily="var(--font-plex)">Arrived</text>
        </svg>
        <p className="mt-3 text-[13px] text-muted sm:hidden">The upper line is what the website showed. The lower line is what the destination received.</p>
        <ol className="mt-5 divide-y divide-line-subtle border-t border-line-subtle">
          {ROUTE_ROWS.map((row, index) => (
            <li key={row.title} className="flex items-start justify-between gap-4 py-3">
              <div>
                <p className="text-[15px] font-medium">{row.title}</p>
                <p className="text-[13px] text-muted">{row.detail}</p>
              </div>
              <Status tone={index === 2 ? "success" : "neutral"} className="shrink-0 whitespace-nowrap">
                {index === 2 ? "Received" : "Done"}
              </Status>
            </li>
          ))}
        </ol>
      </div>
    </ExampleFrame>
  );
}

export function RowList({ rows }: { rows: { label: string; value: ReactNode; mono?: boolean }[] }) {
  return (
    <dl className="divide-y divide-line-subtle">
      {rows.map((row) => (
        <div key={row.label} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-0.5 px-5 py-3">
          <dt className="text-[13px] text-muted">{row.label}</dt>
          <dd className={row.mono ? "t-code min-w-0 break-all" : "min-w-0 text-sm font-medium"}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function StepPanel({ step }: { step: number }) {
  switch (step) {
    case 0:
      return (
        <ExampleFrame title="Browser journey" label="Example">
          <RowList rows={[{ label: "Form", value: "Contact form" }, { label: "Name field", value: "Inlet Test Enquiry" }, { label: "Email field", value: "inlet-test@example.test" }, { label: "Test ID", value: "INLET-TEST-••••", mono: true }, { label: "Submit", value: "One click, never repeated" }]} />
        </ExampleFrame>
      );
    case 1:
      return (
        <ExampleFrame title="Delivery result" label="Example">
          <RowList rows={[{ label: "Destination", value: "Connected inbox" }, { label: "Searching for", value: "INLET-TEST-••••", mono: true }, { label: "Observation window", value: "30 seconds" }, { label: "Result", value: <Status tone="success">Received</Status> }]} />
        </ExampleFrame>
      );
    case 2:
      return (
        <ExampleFrame title="Investigation" label="Example">
          <ol className="divide-y divide-line-subtle">
            {["Read submission result", "Checked destination", "Located notification handler", "Created candidate patch"].map((item) => (
              <li key={item} className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
                {item}
                <Status tone="neutral">Done</Status>
              </li>
            ))}
          </ol>
        </ExampleFrame>
      );
    case 3:
      return (
        <ExampleFrame title="Proposed change" label="Example">
          <pre className="t-code overflow-x-auto px-5 py-4 leading-relaxed" tabIndex={0}>
            <code>
              <span className="block text-muted">src/lib/settings.ts</span>
              <span className="diff-del block px-1">- recipient: env.NOTIFY_EMAIL,</span>
              <span className="diff-add block px-1">+ recipient: env.NOTIFY_ADDRESS,</span>
            </code>
          </pre>
          <RowList rows={[{ label: "Unit tests and build", value: <Status tone="success">Passed</Status> }, { label: "Private preview inbox", value: <Status tone="success">Received</Status> }, { label: "Developer approval", value: <Status tone="warning" icon="pending">Required</Status> }]} />
        </ExampleFrame>
      );
    default:
      return (
        <ExampleFrame title="After deployment" label="Example">
          <RowList rows={[{ label: "Original check", value: <Status tone="danger">Not received</Status> }, { label: "New check, new test ID", value: <Status tone="success">Received</Status> }, { label: "Incident", value: <Status tone="success">Verified recovered</Status> }]} />
        </ExampleFrame>
      );
  }
}

export const SAMPLE_SITES = [
  { name: "Harbour Dental", form: "Book an appointment", result: "Received", tone: "success" as const, next: "In 6 hours" },
  { name: "Northgate Joinery", form: "Request a quote", result: "Not received", tone: "danger" as const, next: "Incident open" },
  { name: "Marlow Architects", form: "Contact us", result: "Unverified", tone: "warning" as const, next: "Reconnect inbox" },
];
