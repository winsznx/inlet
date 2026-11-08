import { Status } from "@inlet/ui";

export const metadata = { title: "Status" };
export const dynamic = "force-dynamic";

type Ready = { status: string; checks?: { database: boolean; queue: boolean; sandbox: boolean; inferenceConfigured: boolean } };

async function readiness(): Promise<Ready | null> {
  try {
    const response = await fetch(`${process.env.API_BASE_URL ?? "http://localhost:4000"}/api/v1/health/ready`, { cache: "no-store", signal: AbortSignal.timeout(6000) });
    return (await response.json()) as Ready;
  } catch {
    return null;
  }
}

export default async function StatusPage() {
  const ready = await readiness();
  const rows = [
    ["Database", ready?.checks?.database],
    ["Job queue", ready?.checks?.queue],
    ["Sandbox runtime and egress gateway", ready?.checks?.sandbox],
    ["Model inference configured", ready?.checks?.inferenceConfigured],
  ] as const;
  return (
    <div className="shell py-14 lg:py-20">
      <div className="max-w-[720px]">
        <h1 className="t-h2">Status</h1>
        <p className="t-body-lg mt-4 text-ink-2">{ready ? "Live readiness of each dependency, checked when this page loaded." : "The Inlet service did not answer."}</p>
        <ul className="mt-8 divide-y divide-line border-y border-line">
          {rows.map(([name, ok]) => (
            <li key={name} className="flex flex-wrap items-center justify-between gap-2 py-4">
              <span className="text-[15px]">{name}</span>
              {ok === undefined ? <Status tone="warning">Unknown</Status> : ok ? <Status tone="success">Ready</Status> : <Status tone="danger">Not ready</Status>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
