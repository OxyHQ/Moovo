# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
#
# Production image for the @moovo/backend service.
#
# Multi-stage, multi-arch. `node:22.23-alpine` and `oven/bun` are multi-arch
# manifests, so this image builds natively on AWS Graviton (linux/arm64) as well
# as x86_64 — Docker selects the right base layer per target platform.
#
# Every base image and the `# syntax=` frontend is pinned by its multi-arch
# INDEX digest. The digest is what the build uses; the tag beside it is only for
# readability (and for gates that read the version). A re-pushed tag therefore
# cannot change this image. A bump needs a new digest and an owner re-review of
# the build inputs (.github/scripts/reviewed-image.py pin).
#
# Build context is the monorepo ROOT (bun workspaces):
#   docker build -t moovo-backend:test .
#
# Pipeline:
#   build: bun install --frozen-lockfile (incl. devDependencies for the build)
#          && bun run build:backend           (tsc shared-types + esbuild bundle
#                                               -> packages/backend/dist/index.js
#                                               +  packages/backend/dist/db/migrate.js)
#          && reinstall the API's production-only deps, no lifecycle scripts
#   run:   bun packages/backend/dist/index.js
#   migrate (one-shot, not the CMD):
#          bun packages/backend/dist/db/migrate.js --target-database=moovo --phase=<pre|post|all>
#
# The API runs on BUN, not Node, since 2026-10. The runtime stage is
# oven/bun:1.4.3-alpine: the same pinned Bun the builder installs with, on the
# same musl libc the runtime used before, so the production dependency tree
# installed below matches it. Bun serves the same esbuild bundle (ESM,
# platform=node) unchanged. The migrator command in
# .github/scripts/run-migration-task.sh names `bun` too and must always name the
# runtime this image ships. Rolling back to Node is reverting the change that
# made this switch: it moved the runtime stage and that command together.
#
# The migrator is a SECOND entry point and the image must carry both it and the
# `.sql` files it applies. Neither was here before: the image shipped a single
# bundled `dist/index.js`, so there was no way to migrate the production
# database from the image that contains the migrations — a deploy shipped new
# code against a schema nothing had applied, and reported success.
#
# @moovo/shared-types is a first-party workspace package; the API bundle
# INLINES it (see packages/backend/build.ts), so the runtime image needs neither
# its dist nor its build-time devDependencies.

# ---------------------------------------------------------------------------
# Stage 1: builder — install the full dependency graph and bundle the API.
# ---------------------------------------------------------------------------
FROM node:22.23-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS builder

# Toolchain for any dependency that needs a node-gyp fallback when a prebuilt
# binary is unavailable for the target arch. Confined to the builder stage so it
# never reaches the runtime image.
RUN apk add --no-cache python3 make g++ libc6-compat

# Bun is the package manager / script runner at build time, and the runtime
# stage below is the same pinned Bun image. The musl build from the matching
# alpine image works on amd64 and arm64.
COPY --from=oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Install dependencies first for better layer caching. Copy only the manifests,
# the lockfile and the bun config (hoisted linker — required so the runtime
# image can resolve deps from the root node_modules; see the Bun-1.3 isolated
# linker gotcha) so this layer is reused unless dependencies change. Every
# workspace's package.json is included (only the manifests: the app sources are
# never copied) so the workspace graph is exactly the one bun.lock records. A new
# workspace needs its line here too.
COPY package.json bun.lock bunfig.toml ./
COPY packages/backend/package.json ./packages/backend/package.json
COPY packages/frontend/package.json ./packages/frontend/package.json
COPY packages/courier-app/package.json ./packages/courier-app/package.json
COPY packages/fleet-dashboard/package.json ./packages/fleet-dashboard/package.json
COPY packages/tracker-app/package.json ./packages/tracker-app/package.json
COPY packages/shared-types/package.json ./packages/shared-types/package.json

# Copy shared-types source before install so its `postinstall` (tsc) can build
# the package's dist during `bun install`.
COPY packages/shared-types ./packages/shared-types

# Install exactly what bun.lock records (devDependencies included — esbuild and
# TypeScript bundle the API; the root postinstall builds @moovo/shared-types).
# --frozen-lockfile: a lockfile that disagrees with the manifests fails the
# build instead of being re-resolved inside it. bun.lock records every
# platform's native optional packages (the musl arm64 and x64 builds of
# lightningcss and @swc/core included), so the musl stage needs nothing the
# lockfile lacks. That was the reason this used to be a plain `bun install`;
# CI's image jobs build this stage for linux/amd64 and linux/arm64 on every
# change to it.
RUN bun install --frozen-lockfile

# Copy the source needed to build the API.
COPY packages/backend ./packages/backend

# Build shared-types then bundle the API with esbuild ->
# packages/backend/dist/index.js (externalizes every node_modules dependency,
# @oxy.so/* included, and inlines only @moovo/*; see packages/backend/build.ts).
# The externals are resolved at runtime from the node_modules copied below.
RUN bun run build:backend

# Fail fast if either expected entry point was not emitted.
#
# The migrator is asserted separately and deliberately: a build that silently
# stopped emitting it would leave the server bundle here and perfectly
# functional, so nothing would notice until a deploy's migration task failed —
# or, before that task existed, until production served code whose tables were
# never created.
RUN test -f packages/backend/dist/index.js \
 || (echo "ERROR: packages/backend/dist/index.js was not produced by the build" && exit 1)
RUN test -f packages/backend/dist/db/migrate.js \
 || (echo "ERROR: packages/backend/dist/db/migrate.js was not produced by the build" && exit 1)

# The SQL the migrator applies. `src/db/migrate.ts` resolves its folder relative
# to its OWN directory, so the emitted `dist/db/migrate.js` looks for
# `dist/db/migrations` — which is what this copy creates. Resolving from the
# module's own directory rather than from the package root is what lets the same
# line of code find `src/db/migrations` in development and this folder in the
# image, with neither layout knowing about the other.
RUN cp -R packages/backend/src/db/migrations packages/backend/dist/db/migrations \
 && test -n "$(ls -A packages/backend/dist/db/migrations/*.sql 2>/dev/null)" \
 || (echo "ERROR: no .sql migrations were copied into the image" && exit 1)

# The runtime dependency tree: a clean install from the same lockfile of the
# API's own production dependencies and nothing else (bun has no `prune`). The
# API bundle inlines first-party code, so no workspace's dist is needed.
#
#   --filter @moovo/backend  only the API workspace. Without it every workspace's
#                            production dependencies came along: Expo, React
#                            Native, Metro and TypeScript, 1.1 GB of the image.
#   --omit peer              bun installs peer dependencies by default, and
#                            @oxy.so/protocol declares a non-optional peer on
#                            expo-modules-core, which pulls Expo and React Native
#                            back in. Every peer the bundle imports (express,
#                            drizzle-orm, postgres) is a direct dependency of
#                            @moovo/backend, so nothing it loads is lost.
#   --ignore-scripts         no lifecycle script runs. Measured on this closure:
#                            the only one is msgpackr-extract's `install`
#                            (node-gyp-build-optional-packages), which compiles
#                            from source only when no prebuilt binary exists;
#                            @msgpackr-extract/msgpackr-extract-linux-{x64,arm64}
#                            ship the musl prebuilds, so it is not needed. CI's
#                            image smoke asserts the native addon still loads.
#
# The runner copies the ROOT node_modules only, so a nested
# packages/backend/node_modules (a version the hoisted linker could not hoist)
# would be silently left behind: fail the build instead.
RUN rm -rf node_modules packages/*/node_modules \
 && bun install --production --frozen-lockfile --filter @moovo/backend --omit peer --ignore-scripts
RUN test ! -e packages/backend/node_modules \
 || (echo "ERROR: the production install nested packages/backend/node_modules, which the runner does not copy" && exit 1)

# ---------------------------------------------------------------------------
# Stage 2: runner — the pinned Bun runtime, production deps and the bundle.
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 AS runner

ENV NODE_ENV=production \
    PORT=3001

# libc6-compat: glibc shim some prebuilt native binaries expect on Alpine/musl.
# No dumb-init any more: the base image's entrypoint EXECs the CMD, so Bun is
# PID 1 and receives the SIGTERM ECS sends on a rollout itself; src/index.ts
# registers the graceful-shutdown handler. CI's image smoke
# (.github/scripts/smoke-api-image.sh) asserts both.
RUN apk add --no-cache libc6-compat

WORKDIR /app

# The app files are ROOT-owned and read-only to the user the API runs as: no
# --chown. The process cannot rewrite its own bundle, migrations or
# node_modules. Nothing it runs writes under /app; the migrator stages a
# journal prefix in the OS temp dir (/tmp, world-writable with the sticky bit
# in the base image) and Bun's cache lives in the bun user's home. CI's image
# smoke asserts both: no write under /app succeeds, a write to /tmp does.
#
# The pruned (production-only) dependency tree and the workspace manifests, so
# the workspace resolution stays valid.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages/backend/package.json ./packages/backend/package.json

# The bundled API and its migrations.
COPY --from=builder /app/packages/backend/dist ./packages/backend/dist

# Run as the image's own unprivileged `bun` user (uid/gid 1000, like Node's
# `node`).
USER bun

EXPOSE 3001

# Container-level health check hitting the app's /health endpoint. ECS does not
# read it (the task definition declares no healthCheck; the ALB probes
# /health/ready), so it serves `docker run` and local compose.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"

# The base image puts a `node` on PATH, but it is a symlink to bun
# (/usr/local/bun-node-fallback-bin/node): there is no Node in this image, so
# `node <file>` would run Bun while claiming otherwise. Every command names
# `bun` explicitly, including the migrator one-shot that overrides this CMD.
CMD ["bun", "packages/backend/dist/index.js"]
