FROM mcr.microsoft.com/playwright:v1.65.0-noble AS build
WORKDIR /build
RUN npm init -y >/dev/null && npm install --no-audit --no-fund playwright@1.65.0 esbuild@0.25.11 zod@4 uuidv7@1
COPY packages/domain/src packages/domain/src
COPY packages/browser-runner/src packages/browser-runner/src
RUN npx esbuild packages/browser-runner/src/main.ts packages/browser-runner/src/probe.ts \
    --bundle --platform=node --format=esm --target=node22 --outdir=/runner --out-extension:.js=.mjs \
    --external:playwright --alias:@inlet/domain=/build/packages/domain/src/index.ts \
    --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);"

FROM mcr.microsoft.com/playwright:v1.65.0-noble
WORKDIR /runner
COPY --from=build /runner /runner
COPY --from=build /build/node_modules/playwright /runner/node_modules/playwright
COPY --from=build /build/node_modules/playwright-core /runner/node_modules/playwright-core
RUN chmod -R a-w /runner
ENV HOME=/tmp/home XDG_CONFIG_HOME=/tmp/home/.config XDG_CACHE_HOME=/tmp/home/.cache
USER pwuser
CMD ["node", "/runner/main.mjs"]
