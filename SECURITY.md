# Security

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's private vulnerability reporting on this repository, with reproduction steps and the commit you tested. If your report includes a credential, rotate it first and send only a redacted example.

## What Inlet assumes

Every website, repository, email and model response is untrusted. An attacker may control page text, hidden DOM, redirects, repository comments, dependency scripts and misleading API responses, and may get the model to recommend an unauthorized action. The enforcement below holds regardless of what the model says.

## Enforced boundaries

| Boundary | Enforced by | Source |
| --- | --- | --- |
| Which websites can be tested | Ownership check, public-address validation, DNS and redirect checks | `packages/policy/src/url.ts`, `apps/api/src/plumbing/verification.ts` |
| Browser network access | Sandbox network with no route out, plus an egress gateway that allows only the verified host | `infra/egress-gateway`, `packages/sandbox/src/oci.ts` |
| Repair network access | Private internal network with no egress | `packages/sandbox/src/preview.ts` |
| Process limits | Read-only root, all capabilities dropped, non-root user, CPU, memory, process and wall-clock limits | `packages/sandbox/src/oci.ts` |
| What the model can do | A fixed tool list, schema validation and call budgets | `packages/agent/src/loop.ts`, `packages/policy/src/tools.ts` |
| What a patch can change | Approved paths only. No tests, manifests, lockfiles, CI, env files or symlinks. Limit of 5 files and 300 lines | `packages/policy/src/diff-guard.ts`, `packages/policy/src/paths.ts` |
| Which commands run | Named profiles resolved on the server. Model text never reaches a shell | `packages/policy/src/commands.ts` |
| Credentials | AES-256-GCM at rest, never returned by the API, never placed in a sandbox | `packages/evidence/src/index.ts` |
| Tenant isolation | Organization scope on every query, role checks on the server | `apps/api/src/plumbing/auth.ts` |
| Shipping code | A person approves. Inlet never merges or deploys customer code | `apps/api/src/routes/incidents.ts` |

## Known limits

- Local development uses Docker containers with `runc`. A container is not a microVM. The Vultr profile uses gVisor (`runsc`), and `infra/scripts/verify-sandbox.sh` has to pass on the real host before that isolation is relied on.
- Chromium runs with `--no-sandbox` because the container is the sandbox.
- The worker holds the Docker socket because it starts the sandboxes. Treat the worker host as trusted, and keep it separate from anything that handles untrusted input directly.
- Webhook replay protection is held in memory and resets when the API restarts. Timestamps still expire after 5 minutes.
