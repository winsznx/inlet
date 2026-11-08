# Deploying Inlet on Vultr

Nothing here has been run against a live Vultr instance yet. Treat the steps as the deployment plan, and run `verify-sandbox.sh` on the real host before relying on any isolation claim.

## What runs where

One Vultr Cloud Compute instance (Ubuntu 24.04) runs Caddy, the web app, the API, the worker, PostgreSQL, Redis, the owned sample sites, a private Mailpit, and the sandbox containers. Agent calls go to Vultr Serverless Inference at `https://api.vultrinference.com/v1`.

Use a plan with at least 4 vCPU and 8 GB of memory. A repair run holds two 2 GB repair containers and a browser at the same time.

## Steps

1. Create the instance with an SSH key and a non-root deploy user. Open only 22, 80 and 443 in the firewall.
2. Install Docker Engine and the compose plugin.
3. Install gVisor, copy `vultr/gvisor-daemon.json` to `/etc/docker/daemon.json`, and restart Docker.
4. Clone the repository and copy `infra/production.env.example` to `infra/production.env`. Fill in every secret.
5. Export `INLET_DOMAIN`, `ACME_EMAIL`, `POSTGRES_PASSWORD`, `FIXTURE_CONTROL_TOKEN`, `EGRESS_CONTROL_TOKEN` and `DOCKER_GID` (`stat -c %g /var/run/docker.sock`).
6. Point the domain at the instance.
7. Run these in order. Each one is a dry run until you add `--apply`.

```sh
infra/scripts/check-prereqs.sh
infra/scripts/deploy.sh --apply
infra/scripts/verify-sandbox.sh --apply
infra/scripts/smoke-production.sh
```

## Sandbox backend

`SANDBOX_BACKEND=vultr-gvisor` starts every sandbox with the `runsc` runtime. It keeps the same egress gateway, read-only root filesystem, dropped capabilities and limits as local development. The worker refuses to report ready if `runsc` is not installed.

Microsandbox needs `/dev/kvm`, and there is no adapter for it in this repository.

## Operations

- `pnpm ops:status` summarises health, queues, active runs and pending cleanups.
- `infra/scripts/backup.sh --apply` writes a PostgreSQL dump and an artifact archive.
- `infra/scripts/restore-test.sh --apply` restores the latest backup into a throwaway database.
- `infra/scripts/rollback.sh --apply <git-ref>` rebuilds and restarts a previous version.
