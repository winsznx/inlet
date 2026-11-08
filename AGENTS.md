# Working in this repository

Start the stack with the commands in `README.md`. A change isn't finished until it has run against the real stack.

- `apps/web` is the Next.js app. `apps/api` is the Fastify API. `apps/worker` runs jobs and starts sandboxes.
- `packages/policy` decides what is allowed. Change it deliberately and add tests.
- `packages/domain/src/states.ts` is the only authority for state transitions.
- Models propose. Controllers decide. Never let model text choose a state, a command or a path.
- Never put credentials in a sandbox, a prompt, an artifact or a response.
- Controlled fixtures live in `fixtures/` and stay labelled wherever they appear. The non-AI harness must never be presented as a model result.
- Use `pnpm test:judge` to confirm the full loop still produces real evidence.
- `internal/` is private and ignored.
