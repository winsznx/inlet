"use client";

import { useState } from "react";
import { cx, Status } from "@inlet/ui";
import { ExampleFrame, RowList } from "./visuals";

const COLUMNS = [
  {
    id: "browser",
    title: "Browser event",
    rows: [
      { label: "Form submitted", value: "Yes" },
      { label: "Success message", value: "Displayed" },
      { label: "Response", value: "200" },
    ],
  },
  {
    id: "inbox",
    title: "Inbox observation",
    rows: [
      { label: "Destination", value: "Reachable" },
      { label: "Observation window", value: "30 seconds" },
      { label: "Matching message", value: <Status tone="danger">None</Status> },
    ],
  },
  {
    id: "patch",
    title: "Patch checks",
    rows: [
      { label: "Types and build", value: <Status tone="success">Passed</Status> },
      { label: "Unit tests", value: <Status tone="success">Passed</Status> },
      { label: "Preview delivery", value: <Status tone="success">Received</Status> },
    ],
  },
];

export function EvidenceSample() {
  const [tab, setTab] = useState("browser");
  return (
    <ExampleFrame title="Form submitted. Enquiry not received." label="Read-only example">
      <div className="flex border-b border-line lg:hidden" aria-hidden>
        {COLUMNS.map((column) => (
          <button key={column.id} type="button" tabIndex={-1} onClick={() => setTab(column.id)} className={cx("min-h-11 flex-1 border-b-2 px-2 text-[13px] font-medium", tab === column.id ? "border-copper text-ink" : "border-transparent text-muted")}>
            {column.title}
          </button>
        ))}
      </div>
      <div className="grid lg:grid-cols-3 lg:divide-x lg:divide-line-subtle">
        {COLUMNS.map((column) => (
          <section key={column.id} className={cx(tab === column.id ? "block" : "sr-only lg:not-sr-only")}>
            <h3 className="hidden px-5 pb-1 pt-4 text-sm font-semibold lg:block">{column.title}</h3>
            <h3 className="sr-only lg:hidden">{column.title}</h3>
            <RowList rows={column.rows} />
          </section>
        ))}
      </div>
    </ExampleFrame>
  );
}
