# Verity re-executor worker. Replays assigned submissions and votes on-chain
# with its own key (REEXECUTOR_SECRET_KEY_FILE or REEXECUTOR_SECRET_KEY).
#
# Submitted functions run in a WebAssembly sandbox inside the worker process,
# so this image needs no container runtime, socket or extra privileges.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY backend/src/chain/generated/escrow-gate/package.json backend/src/chain/generated/escrow-gate/package.json
COPY reexecutor-agent/package.json reexecutor-agent/package.json
# Downloaded packages are kept in a build cache shared by the three images,
# so a rebuild, or a retry after a dropped connection, does not start over.
RUN --mount=type=cache,id=verity-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm-store \
      --config.fetch-retries=5 --config.fetch-timeout=120000 \
      --filter @verity/reexecutor-agent...

COPY backend/src/chain/generated/escrow-gate backend/src/chain/generated/escrow-gate
COPY reexecutor-agent reexecutor-agent
# runner.ts loads ./replay-worker.mjs relative to import.meta.url; the build
# compiles TypeScript to dist/ and places replay-worker.mjs next to runner.js.
RUN --mount=type=cache,id=verity-pnpm-store,target=/pnpm-store \
    pnpm --filter escrow-gate build \
 && pnpm --filter @verity/reexecutor-agent build \
 && cp reexecutor-agent/src/sandbox/replay-worker.mjs reexecutor-agent/dist/sandbox/replay-worker.mjs \
 && rm -rf node_modules reexecutor-agent/node_modules backend/src/chain/generated/escrow-gate/node_modules \
 && pnpm install --prod --frozen-lockfile --store-dir /pnpm-store \
      --config.fetch-retries=5 --config.fetch-timeout=120000 \
      --filter @verity/reexecutor-agent...

FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/backend/src/chain/generated/escrow-gate/package.json ./backend/src/chain/generated/escrow-gate/package.json
COPY --from=build /app/backend/src/chain/generated/escrow-gate/dist ./backend/src/chain/generated/escrow-gate/dist
COPY --from=build /app/backend/src/chain/generated/escrow-gate/node_modules ./backend/src/chain/generated/escrow-gate/node_modules
COPY --from=build /app/reexecutor-agent/package.json ./reexecutor-agent/package.json
COPY --from=build /app/reexecutor-agent/node_modules ./reexecutor-agent/node_modules
COPY --from=build /app/reexecutor-agent/dist ./reexecutor-agent/dist
WORKDIR /app/reexecutor-agent
USER node
CMD ["node", "dist/index.js"]
