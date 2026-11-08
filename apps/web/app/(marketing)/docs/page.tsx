import Link from "next/link";

export const metadata = { title: "Documentation" };

const DEFINITIONS = [
  ["Received", "The browser submitted the test and the same unique ID was found in the destination."],
  ["Not received", "The submission happened, the destination was reachable, and nothing matching arrived during the observation window."],
  ["Unverified", "The destination could not be reached or the submission could not be confirmed. Inlet makes no claim either way."],
  ["Browser failed", "Navigation, a field or the submit control failed before a credible submission."],
  ["Patch ready", "A patch inside the allowed files passed every required check and delivered a message in a private preview."],
  ["Verified recovered", "After deployment, a new browser run produced a new message at the destination."],
];

const FAQ = [
  ["Can Inlet test any website?", "Only websites you confirm you control, by DNS TXT record or an HTML meta tag. CAPTCHA-protected forms need a different test route because Inlet does not try to bypass them."],
  ["Which code can it repair?", "Next.js and Node.js handlers with a testable mail adapter are the supported stack. If the cause is outside the code, you get a diagnosis and what to check next."],
  ["What reaches the AI model?", "Sanitized run evidence and files in the paths you approved. Environment files and credentials are removed before anything is read, and no credentials ever enter a browser or repair environment."],
];

export default function DocsPage() {
  return (
    <div className="shell py-14 lg:py-20">
      <div className="max-w-[720px]">
        <h1 className="t-h2">Documentation</h1>
        <p className="t-body-lg mt-4 text-ink-2">How to set up a check, what each result means, and where the safety boundaries are.</p>

        <h2 className="t-h3 mt-14">Set up a check</h2>
        <ol className="mt-4 grid list-decimal gap-3 pl-5 text-[15px] text-ink-2">
          <li>Add the exact page that holds your form and confirm you control the website.</li>
          <li>Connect the destination: an IMAP mailbox read-only, or a signed inbound endpoint.</li>
          <li>Let Inlet propose a field mapping and correct anything it got wrong.</li>
          <li>Optionally connect a repository or upload a source archive so failures can be investigated.</li>
          <li>Run the first check, then set a schedule. The shortest interval is 15 minutes.</li>
        </ol>

        <h2 className="t-h3 mt-14">Destinations</h2>
        <p className="mt-3 text-[15px] text-ink-2">A provider accepting a message is not the same as the message arriving, so Inlet only counts what it can find at the destination. IMAP access is read-only and limited to the folder you choose. Inbound endpoints must send an HMAC signature and a recent timestamp.</p>

        <h2 className="t-h3 mt-14">Result definitions</h2>
        <dl className="mt-4 divide-y divide-line border-y border-line">
          {DEFINITIONS.map(([term, detail]) => (
            <div key={term} className="grid gap-1 py-3.5 sm:grid-cols-[170px_1fr] sm:gap-6">
              <dt className="text-[15px] font-medium">{term}</dt>
              <dd className="text-[15px] text-muted">{detail}</dd>
            </div>
          ))}
        </dl>

        <h2 className="t-h3 mt-14">Safety</h2>
        <ul className="mt-4 grid list-disc gap-3 pl-5 text-[15px] text-ink-2">
          <li>Every browser and repair run uses a new container with a read-only filesystem, no Linux capabilities, and CPU, memory, process and time limits.</li>
          <li>Containers can only reach the network through a gateway that allows the verified website. Everything else is refused and logged.</li>
          <li>The model can only call a fixed list of tools. Website text, repository files and emails are treated as untrusted data.</li>
          <li>Patches cannot change tests, dependency manifests, CI, or environment files. Nothing is merged or deployed by Inlet.</li>
        </ul>

        <h2 className="t-h3 mt-14">FAQ</h2>
        <div className="mt-4 grid gap-6">
          {FAQ.map(([question, answer]) => (
            <div key={question}>
              <h3 className="text-[15px] font-semibold">{question}</h3>
              <p className="mt-1 text-[15px] text-muted">{answer}</p>
            </div>
          ))}
        </div>
        <p className="mt-14 text-[15px]">
          <Link href="/demo" className="text-copper-text underline underline-offset-4">Run the live example</Link> to see a check from start to finish.
        </p>
      </div>
    </div>
  );
}
