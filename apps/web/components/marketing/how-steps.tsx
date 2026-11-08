"use client";

import { useEffect, useRef, useState } from "react";
import { cx } from "@inlet/ui";
import { StepPanel } from "./visuals";

export const STEPS = [
  { title: "Submit the form", body: "A browser fills and submits a clearly marked test enquiry." },
  { title: "Check where it went", body: "Inlet looks for the matching test message in the destination you connected." },
  { title: "Investigate a failure", body: "When delivery breaks, Inlet examines the run and the approved application code." },
  { title: "Review a tested repair", body: "Your developer sees the change, the test results, and what still needs approval." },
  { title: "Confirm it's working", body: "After deployment, Inlet submits a new enquiry and checks delivery again." },
];

export function HowSteps() {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    const items = refs.current.filter((item): item is HTMLLIElement => item !== null);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(items.indexOf(entry.target as HTMLLIElement));
        }
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    items.forEach((item) => observer.observe(item));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="mt-12 grid gap-10 lg:mt-16 lg:grid-cols-[42fr_58fr] lg:gap-12">
      <ol>
        {STEPS.map((step, index) => (
          <li
            key={step.title}
            ref={(node) => {
              refs.current[index] = node;
            }}
            className="border-t border-line lg:min-h-[168px]"
          >
            <button type="button" onClick={() => setActive(index)} aria-pressed={active === index} className="flex w-full gap-5 py-6 text-left">
              <span className={cx("t-code pt-1.5", active === index ? "text-copper-text" : "text-muted")}>{String(index + 1).padStart(2, "0")}</span>
              <span>
                <span className="t-h3 block">{step.title}</span>
                <span className="mt-2 block max-w-[42ch] text-[15px] text-muted">{step.body}</span>
              </span>
            </button>
            <div className="pb-6 lg:hidden">
              <StepPanel step={index} />
            </div>
          </li>
        ))}
      </ol>
      <div className="hidden lg:block">
        <div className="sticky top-28" aria-live="polite">
          <StepPanel step={active} />
        </div>
      </div>
    </div>
  );
}
