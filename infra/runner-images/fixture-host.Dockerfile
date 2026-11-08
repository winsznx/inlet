FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate

WORKDIR /opt/fixture
COPY fixtures/enquiry-site/package.json fixtures/enquiry-site/pnpm-lock.yaml fixtures/enquiry-site/pnpm-workspace.yaml site/
RUN cd site && pnpm install --frozen-lockfile

COPY fixtures/enquiry-site/ site/
COPY fixtures/malicious-page/ attack/
COPY fixtures/fixture-host/ host/
RUN git config --global --add safe.directory '*' && node host/prepare.mjs

EXPOSE 3110 3111 3112 3113 3190
CMD ["node", "host/server.mjs"]
