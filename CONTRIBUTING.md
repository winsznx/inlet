# Contributing

## Setup

Node 24, pnpm 12.16 and Docker are required. The README has the commands to start the stack.

## Before opening a pull request

```sh
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:integration   # needs the local stack
pnpm test:security      # needs the local stack
```

If you changed anything a user can see, also run `pnpm test:e2e` and `pnpm test:visual`, and look at the screenshots in `.local-artifacts/qa/screens`.

## Ground rules

- A delivery result needs evidence from the destination. A toast, an HTTP 200 or model text is never enough.
- Don't weaken a policy, guard or test to get a pass. Fix the cause.
- Run states and incident states change only through `packages/domain/src/states.ts`.
- Security boundaries belong in code, not in prompts.
- Commit messages describe the change in plain words.
