export const metadata = { title: "Terms" };

export default function TermsPage() {
  return (
    <div className="shell py-14 lg:py-20">
      <div className="max-w-[720px]">
        <h1 className="t-h2">Terms</h1>
        <p className="mt-4 rounded-panel border border-warning px-4 py-3 text-sm text-ink-2">Baseline terms. They must be reviewed by the owner and a legal adviser before public deployment.</p>
        <div className="mt-8 grid gap-6 text-[15px] leading-relaxed text-ink-2">
          <section><h2 className="t-section text-ink">Authorized use</h2><p className="mt-2">Only add websites you control or are authorized to test. You are responsible for the test enquiries Inlet submits on your behalf.</p></section>
          <section><h2 className="t-section text-ink">Proposed changes</h2><p className="mt-2">Patches are proposals. Review them yourself before merging or deploying. Passing checks in a test environment does not guarantee behaviour in production.</p></section>
          <section><h2 className="t-section text-ink">Results</h2><p className="mt-2">A result describes what Inlet observed during one check. Unverified means Inlet could not determine the outcome.</p></section>
          <section><h2 className="t-section text-ink">Limits</h2><p className="mt-2">Inlet does not bypass CAPTCHAs, access authentication, or test forms you are not authorized to test. Abusive use may lead to suspension.</p></section>
        </div>
      </div>
    </div>
  );
}
