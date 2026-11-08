import Link from "next/link";
import { Accordion, Status } from "@inlet/ui";
import { buttonClass } from "@inlet/ui/classes";
import { EvidenceSample } from "@/components/marketing/evidence-sample";
import { HowSteps } from "@/components/marketing/how-steps";
import { ExampleFrame, HeroRoute, SAMPLE_SITES } from "@/components/marketing/visuals";

const STAGES = [
  { title: "Customer sends a request", note: "A visitor fills in the form and presses send." },
  { title: "Website displays “Sent”", note: "The page confirms it. The visitor moves on." },
  { title: "Inbox receives nothing", note: "A possible failure: the notification never arrives, and nobody is told." },
];

const AGENCY_POINTS = [
  { title: "Multiple client sites", body: "Each form has its own destination and schedule." },
  { title: "Shared responsibility", body: "Owner, maintainer and viewer roles." },
  { title: "Change history", body: "See what failed, what was approved, and which run confirmed recovery." },
  { title: "Notifications with context", body: "Alert on failure and recovery, not on every successful check." },
];

const SAFETY_POINTS = [
  { title: "Limited access", body: "Test only verified websites and allowed repository paths." },
  { title: "Independent checks", body: "Browser success is compared with a destination receipt." },
  { title: "Developer approval", body: "Inspect the diff and test results before merge or deployment." },
];

const FAQ = [
  { id: "real", title: "Does Inlet send real messages through the form?", content: "Yes. It submits a clearly marked test enquiry to a website you've authorized. You can review the test details and control how often checks run." },
  { id: "know", title: "How does it know an enquiry arrived?", content: "It looks for the unique test identifier in the destination you connected. A success message on the website is not enough." },
  { id: "auto", title: "Will it change my website automatically?", content: "No. For supported source-code problems, Inlet prepares and tests a proposed change. A developer reviews it and decides whether to deploy it." },
  { id: "builder", title: "What if I use a website builder or a hosted form?", content: "Inlet can test an authorized form when the interaction is supported, but source-code repairs require access to the application code. Otherwise you'll get a diagnosis and the next action to take." },
  { id: "try", title: "Can I test it without connecting my own website?", content: "Yes. The live example uses a controlled website and mailbox so you can see exactly how checks work." },
  { id: "unverified", title: "What happens when delivery can't be verified?", content: "Inlet marks the check as unverified and shows what's missing. It won't call a message delivered without evidence from the destination." },
];

export default function LandingPage() {
  return (
    <>
      <section id="product" className="shell pb-[72px] pt-14 lg:pb-[100px] lg:pt-[104px]">
        <div className="grid items-center gap-12 lg:min-h-[546px] lg:grid-cols-12 lg:gap-8">
          <div className="lg:col-span-5">
            <p className="t-overline">FORM DELIVERY, VERIFIED</p>
            <h1 className="t-hero mt-4 max-w-[900px]">Your form says sent. Did the enquiry arrive?</h1>
            <p className="t-body-lg mt-6 max-w-[560px] text-ink-2">Inlet tests your website&rsquo;s enquiry forms, checks whether each test reaches the right inbox, and helps your developer fix failures in the code.</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link href="/demo" className={buttonClass("primary")}>
                Run a live example
              </Link>
              <Link href="#how" className={buttonClass("secondary")}>
                See how it works
              </Link>
            </div>
            <p className="mt-6 text-sm text-muted">Built for developers and agencies maintaining business websites.</p>
          </div>
          <div className="min-w-0 lg:col-span-7">
            <HeroRoute />
          </div>
        </div>
      </section>

      <section id="problem" className="border-t border-line-subtle bg-subtle py-20 lg:py-[120px]">
        <div className="shell">
          <div className="max-w-[760px]">
            <p className="t-overline">THE PROBLEM</p>
            <h2 className="t-h2 mt-3">A success message can hide a lost enquiry.</h2>
            <p className="t-body-lg mt-5 text-ink-2">A visitor submits a request. The website says it went through. But if the notification fails, the business might never see it. Ordinary uptime checks won&rsquo;t catch that gap.</p>
          </div>
          <ol className="mt-12 grid max-w-[1200px] border-y border-line lg:mt-16 lg:grid-cols-3 lg:divide-x lg:divide-line">
            {STAGES.map((stage, index) => (
              <li key={stage.title} className="relative border-l-2 border-line py-6 pl-6 lg:border-l-0 lg:p-8">
                <span className={`t-code ${index === 2 ? "text-danger" : "text-muted"}`}>{index + 1}</span>
                <p className={`t-h3 mt-3 ${index === 2 ? "text-danger" : ""}`}>{stage.title}</p>
                <p className="mt-2 text-[15px] text-muted">{stage.note}</p>
              </li>
            ))}
          </ol>
          <p className="t-body-lg mt-10 font-medium">Inlet checks the step that the success message can&rsquo;t prove.</p>
        </div>
      </section>

      <section id="how" className="shell py-20 lg:py-[120px]">
        <div className="max-w-[760px]">
          <p className="t-overline">FROM TEST TO FIX</p>
          <h2 className="t-h2 mt-3">One check, from the browser to the inbox.</h2>
          <p className="t-body-lg mt-5 text-ink-2">Inlet follows the same route a customer would take, then keeps going until it can tell you what happened.</p>
        </div>
        <HowSteps />
      </section>

      <section id="inside" className="border-t border-line-subtle py-20 lg:py-[120px]">
        <div className="shell">
          <div className="max-w-[760px]">
            <h2 className="t-h2">See the failure. See the evidence. See the fix.</h2>
            <p className="t-body-lg mt-5 text-ink-2">Every result links back to the browser action, delivery check, and exact code change. No guesswork hidden behind a green status light.</p>
          </div>
          <div className="mt-12">
            <EvidenceSample />
          </div>
          <div className="mt-12 grid gap-10 md:grid-cols-2 md:gap-12">
            <div>
              <h3 className="t-h3">A record you can inspect</h3>
              <p className="mt-2 text-[15px] text-muted">Screenshots, timestamps, correlation IDs, run events.</p>
            </div>
            <div>
              <h3 className="t-h3">A patch your developer can review</h3>
              <p className="mt-2 text-[15px] text-muted">Changed files, tests, approval status.</p>
            </div>
          </div>
        </div>
      </section>

      <section id="agencies" className="border-t border-line-subtle bg-subtle py-20 lg:py-[120px]">
        <div className="shell grid gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <p className="t-overline">FOR TEAMS THAT OWN THE CODE</p>
            <h2 className="t-h2 mt-3">Look after every client&rsquo;s enquiry forms in one place.</h2>
            <p className="t-body-lg mt-5 text-ink-2">Add the forms you maintain, choose how often to check them, and get a clear record when delivery changes. If a source-code issue is found, the proposed repair stays in your review process.</p>
            <dl className="mt-8 divide-y divide-line border-y border-line">
              {AGENCY_POINTS.map((point) => (
                <div key={point.title} className="grid gap-1 py-4 sm:grid-cols-[200px_1fr] sm:gap-6">
                  <dt className="text-[15px] font-medium">{point.title}</dt>
                  <dd className="text-[15px] text-muted">{point.body}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="min-w-0 lg:pt-10">
            <ExampleFrame title="Websites" label="Sample sites">
              <ul className="divide-y divide-line-subtle">
                {SAMPLE_SITES.map((site) => (
                  <li key={site.name} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-5 py-4">
                    <div className="min-w-0">
                      <p className="text-[15px] font-medium">{site.name}</p>
                      <p className="text-[13px] text-muted">{site.form}</p>
                    </div>
                    <div className="text-right">
                      <Status tone={site.tone}>{site.result}</Status>
                      <p className="text-[13px] text-muted">{site.next}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </ExampleFrame>
          </div>
        </div>
      </section>

      <section id="control" className="shell py-20 lg:py-[120px]">
        <div className="max-w-[760px]">
          <h2 className="t-h2">The agent can test a fix. You decide what ships.</h2>
          <p className="t-body-lg mt-5 text-ink-2">Browser runs and code tests happen in isolated execution environments. The agent works with a restricted copy of approved files, and you review the proposed change before it reaches production.</p>
        </div>
        <div className="mt-12 grid gap-10 lg:grid-cols-[1fr_1fr] lg:gap-12">
          <dl className="divide-y divide-line border-y border-line">
            {SAFETY_POINTS.map((point) => (
              <div key={point.title} className="py-5">
                <dt className="t-h3">{point.title}</dt>
                <dd className="mt-1.5 text-[15px] text-muted">{point.body}</dd>
              </div>
            ))}
          </dl>
          <ExampleFrame title="Proposed fix" label="Example">
            <div className="grid sm:grid-cols-2 sm:divide-x sm:divide-line-subtle">
              <div className="p-5">
                <p className="text-sm font-semibold">Proposed fix</p>
                <ul className="mt-3 grid gap-2.5">
                  <li><Status tone="success">Type checks</Status></li>
                  <li><Status tone="success">Unit tests</Status></li>
                  <li><Status tone="success">Build</Status></li>
                  <li><Status tone="success">Preview delivery</Status></li>
                </ul>
              </div>
              <div className="border-t border-line-subtle p-5 sm:border-t-0">
                <p className="text-sm font-semibold">Developer approval required</p>
                <p className="mt-3 text-sm text-muted">Nothing is merged or deployed until a person with approval rights accepts this change.</p>
                <div className="mt-4">
                  <Status tone="warning" icon="pending">Awaiting approval</Status>
                </div>
              </div>
            </div>
          </ExampleFrame>
        </div>
      </section>

      <section id="example" className="bg-ink text-white">
        <div className="shell grid items-center gap-10 py-20 lg:grid-cols-2 lg:py-[120px]">
          <div>
            <h2 className="t-h2">Try the check before you connect a website.</h2>
            <p className="t-body-lg mt-5 text-white/80">Use our controlled test site to watch a form submission, the delivery check, and the result. You can also see how Inlet responds when the notification is deliberately broken.</p>
            <Link href="/demo" className="mt-8 inline-flex min-h-11 items-center justify-center rounded-button bg-white px-[18px] text-sm font-semibold text-ink hover:bg-subtle">
              Open the live example
            </Link>
            <p className="mt-4 text-sm text-white/70">The example uses a test website and test mailbox. No customer information is involved.</p>
          </div>
          <ol className="grid gap-px overflow-hidden rounded-panel border border-white/15 bg-white/15" aria-label="Execution sequence">
            {["Preparing", "Opening form", "Submitting", "Checking delivery", "Result"].map((stage, index) => (
              <li key={stage} className="flex items-center justify-between bg-ink px-5 py-3.5 text-[15px]">
                <span>{stage}</span>
                <span className="t-code text-white/50">{index + 1} of 5</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="faq" className="shell py-20 lg:py-[120px]">
        <div className="grid gap-10 lg:grid-cols-12">
          <h2 className="t-h2 lg:col-span-4">Questions</h2>
          <div className="lg:col-span-8">
            <Accordion items={FAQ} />
          </div>
        </div>
        <div className="mt-20 border-t border-line pt-16 lg:mt-[120px]">
          <h2 className="t-h2 max-w-[760px]">Know whether your next enquiry arrived.</h2>
          <p className="t-body-lg mt-4 text-ink-2">Start with the live example, then connect the forms your team maintains.</p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href="/demo" className={buttonClass("primary")}>
              Run a live example
            </Link>
            <Link href="/register" className={buttonClass("secondary")}>
              Create workspace
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
