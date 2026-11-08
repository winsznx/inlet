import { ContactForm } from "../../components/contact-form.tsx";

export const dynamic = "force-dynamic";

export default function ContactPage() {
  return (
    <main>
      <p className="label">{process.env.FIXTURE_ENV_LABEL ?? "Sample environment"}</p>
      <h1>Contact Acme Demo</h1>
      <p>Send us a message and the team will reply within one working day.</p>
      <ContactForm />
    </main>
  );
}
