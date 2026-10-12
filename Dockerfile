# The worker image: one container of this runs per task. It holds agentpool plus common build tooling.
# Extend it (FROM agentpool-worker) to add the languages and tools your repositories need.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl make g++ python3 python3-pip python3-venv ripgrep \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY agents ./agents
COPY skills ./skills
COPY web ./web
ENV NODE_ENV=production
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["--help"]
