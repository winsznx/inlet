export const metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return (
    <div className="shell py-14 lg:py-20">
      <div className="max-w-[720px]">
        <h1 className="t-h2">Privacy</h1>
        <p className="mt-4 rounded-panel border border-warning px-4 py-3 text-sm text-ink-2">Baseline policy. It must be reviewed by the owner and a legal adviser before public deployment.</p>
        <div className="mt-8 grid gap-6 text-[15px] leading-relaxed text-ink-2">
          <section><h2 className="t-section text-ink">What Inlet stores</h2><p className="mt-2">Account details, the websites and destinations you configure, check results, screenshots of test submissions, sanitized network and console summaries, and an audit history of actions in your workspace.</p></section>
          <section><h2 className="t-section text-ink">Test data</h2><p className="mt-2">Test enquiries use a synthetic name, email address and message marked as a test. Inlet searches destinations for the unique test ID and stores a hash of the matching message identifier, not the message body.</p></section>
          <section><h2 className="t-section text-ink">Credentials</h2><p className="mt-2">Mailbox and repository credentials are encrypted at rest with a server-side key. They are never shown again after you enter them and never enter a browser or repair environment.</p></section>
          <section><h2 className="t-section text-ink">Retention</h2><p className="mt-2">Evidence is deleted after the retention period set in your workspace: 7, 30 or 90 days. Deleting a workspace removes its evidence and credentials.</p></section>
          <section><h2 className="t-section text-ink">AI processing</h2><p className="mt-2">When you start a code investigation, sanitized run evidence and files in your approved paths are sent to Vultr Serverless Inference.</p></section>
        </div>
      </div>
    </div>
  );
}
