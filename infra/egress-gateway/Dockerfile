FROM node:24-bookworm-slim
WORKDIR /app
COPY server.mjs policy.mjs healthcheck.mjs ./
USER node
CMD ["node", "server.mjs"]
