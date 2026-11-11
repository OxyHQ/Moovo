<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# Deploy

- **API** to AWS ECS Fargate via `.github/workflows/deploy-aws.yml`
  (`linux/arm64`, ECR `oxy/moovo`). The ECS service, task definition, ALB rule,
  ECR repo and SSM params must be provisioned in `oxy-infra` first (handoff).
  It runs on `workflow_run` once CI has SUCCEEDED on a push to main, for the
  exact commit CI tested, and has no test job of its own. It releases only
  when a backend input (backend, shared-types, manifests, lockfile,
  Dockerfile, the workflow and its scripts) changed since the commit the live
  image was built from, so a frontend-only merge does not roll the API.
- **The API runs on Bun.** The Dockerfile's runtime stage is
  `oven/bun:<pinned>-alpine` (CMD `bun packages/backend/dist/index.js`, Bun is
  PID 1), and the migrator one-shot in `.github/scripts/run-migration-task.sh`
  runs `bun packages/backend/dist/db/migrate.js`. The two must always name the
  same runtime; returning to Node is reverting the change that moved them
  together. The image's `node` is a symlink to bun, so never write `node` in a
  command against it. The task definition (oxy-infra `app-moovo.tf`) sets no
  command, so the image's CMD is what runs. CI guards it three ways:
  `bun run --filter @moovo/backend test:bun` (the unit suite under Bun),
  `bun run check:api-entrypoints` (the built artefacts under bun: every failure
  exits non-zero, a real boot and SIGTERM exit 0) and the `API image smoke`
  job (`.github/scripts/smoke-api-image.sh`: the real image against Postgres,
  both migrator phases, a workload-identity token minted with the production
  `@oxy.so/core`, `/health/ready`, PID 1, graceful SIGTERM). A test file that
  must run under both runners uses `src/__tests__/fixtures/runner-compat.ts`
  instead of `vi.hoisted`/`vi.stubEnv`/`vi.stubGlobal`/`.rejects.toSatisfy`.
- **Four separate Cloudflare Pages projects**, one workflow each, all using
  `wrangler pages deploy`:

  | Workflow | Package | Pages project |
  |---|---|---|
  | `deploy-cloudflare.yml` | `packages/frontend` | `moovo` |
  | `deploy-cloudflare-go.yml` | `packages/courier-app` | `moovo-go` |
  | `deploy-cloudflare-hub.yml` | `packages/fleet-dashboard` | `moovo-hub` |
  | `deploy-cloudflare-tracker.yml` | `packages/tracker-app` | `moovo-tracker` |

  Each project and its DNS must be created before the workflow can succeed
  (handoff). A change to the shared frontend stack usually needs all four
  redeployed, not just `deploy-cloudflare.yml`.
- CI (`.github/workflows/ci.yml`) runs lint, tests (vitest and, for the unit
  suite, Bun), the API entrypoint check, the API image smoke, the API build and
  the app build on every push and PR.
- **Biome** (root `biome.json`, version pinned in the root `package.json`)
  formats and lints the whole repo; there is no ESLint or Prettier. `bun run
  lint` is `biome check .`, CI runs `bunx biome ci .` in its own ungated job.
  Every rule runs at the recommended preset's level; there is no warning
  baseline, and `biome ci .` reports zero warnings and zero infos. A
  justified exception is a single-line `biome-ignore` with its reason on the
  line it covers, never a rule lowered in `biome.json`. `biome-plugins/expo-env-vars.grit` (scoped to the four Expo
  apps) refuses computed `process.env[...]` reads and destructuring of
  `process.env`, by declaration (`const`/`let`/`var`) or by assignment
  (`({ A } = process.env)`), because Metro inlines only static `process.env.EXPO_PUBLIC_*`
  member reads and anything else is `undefined` in the shipped bundle.
