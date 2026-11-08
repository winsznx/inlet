FROM node:24-bookworm-slim AS build
WORKDIR /build
RUN npm init -y >/dev/null && npm install --no-audit --no-fund esbuild@0.25.11 zod@4 uuidv7@1
COPY packages/domain/src packages/domain/src
COPY packages/policy/src packages/policy/src
COPY packages/repair-runner/src packages/repair-runner/src
RUN npx esbuild packages/repair-runner/src/main.ts \
    --bundle --platform=node --format=esm --target=node22 --outfile=/runner/main.mjs \
    --alias:@inlet/domain=/build/packages/domain/src/index.ts \
    --alias:@inlet/policy=/build/packages/policy/src/index.ts \
    --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);"

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g --no-audit --no-fund pnpm@12.16.1
WORKDIR /runner
COPY --from=build /runner /runner
RUN mkdir -p /work /deps && chown node:node /work /deps && chmod -R a-w /runner
ENV HOME=/tmp/home
USER node
CMD ["node", "/runner/main.mjs"]
