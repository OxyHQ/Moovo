<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# Packages

npm releases: merging a version bump to main publishes it (`release-packages.yml`, Oxy's
shared workflow, OIDC, once CI passed on that commit); a package's gates are CI. Never publish
from a laptop — `~/Oxy/docs/npm-releases.md`.

| Package | Path | Role |
|---|---|---|
| `@moovo/frontend` | `packages/frontend/` | Expo customer app |
| `@moovo/courier-app` | `packages/courier-app/` | Expo app for couriers, shipped as **Moovo Go** |
| `@moovo/fleet-dashboard` | `packages/fleet-dashboard/` | Fleet and ops dashboard, shipped as **Moovo Hub** |
| `@moovo/tracker-app` | `packages/tracker-app/` | Public parcel-tracking app, shipped as **Moovo Tracker** |
| `@moovo/backend` | `packages/backend/` | Express API (TypeScript, PostgreSQL, Socket.IO) |
| `@oxy.so/moovo-contracts` | `packages/contracts/` | Canonical material transport schemas and OpenAPI |
| `@oxy.so/moovo-sdk` | `packages/sdk/` | Headless Oxy-linked transport client |
| `@moovo/app-shell` | `packages/app-shell/` | Source shared by the four Expo apps (never built or published) |
| `@moovo/shared-types` | `packages/shared-types/` | Domain DTOs, still largely inherited marketplace shapes awaiting courier replacements |

**`@moovo/app-shell` holds every file the Expo apps would otherwise copy**: the
notifications and settings screens (`screens/*`), the nav shell (`NavRail`,
`BottomTabBar`), the Oxy-linked API client, socket opener, notification hooks, i18n instance
and theme storage. It holds NO UI primitives: every button, field, card, switch, menu, dialog,
header, chip and picker is Bloom, composed in place (`@oxy.so/bloom/<family>`), and the one
brand file is the Moovo `Logo`. A missing primitive is added to Bloom first, then used here, never
written into an app. The UI language is Oxy's (`OxyProvider language`, Oxy's `LanguageSelector`
sheet), not a per-app picker. Apps import `@moovo/app-shell/<path>` (tsconfig `paths` and Metro
`extraNodeModules` resolve it to source; each `global.css` has an `@source` for it, or its
classes are never generated). A route file in an app is a re-export of a shell screen, and
per-app differences are props (`showBack`, `items`), never copies. Add a new shared file here,
not to one app; do not paste a file into a second app. Inside the package use relative imports,
not `@/`.

**The root script names do not match the package names**, which is not guessable
from the tree: `bun run dev:courier` / `build:courier` drive `@moovo/courier-app`
(Go), `bun run dev:hub` / `build:hub` drive `@moovo/fleet-dashboard` (Hub), and
`bun run dev:tracker` / `build:tracker` drive `@moovo/tracker-app` (Tracker).
`dev:frontend` adds `--clear --tunnel`. Shared types build with
`bun run build:shared-types`.

Stack: Expo, NativeWind (Tailwind + postcss), Reanimated, Zustand, TanStack Query
and expo-router on all four apps; Express, PostgreSQL (drizzle-orm +
postgres.js via `@oxy.so/db`), optional Redis and Socket.IO on the backend;
`@oxy.so/bloom` for UI; `@oxy.so/core` (including `@oxy.so/core/server`) and
`@oxy.so/services` for device-first auth. Client id is
`EXPO_PUBLIC_OXY_CLIENT_ID`; backend auth wiring is in
`packages/backend/src/middleware/auth.ts`.

**Development bundles of all four apps use Noxcturnal**, Expo's oxc transformer
(`experiments.noxcturnalTransformWorker` in each `app.config.js`). It stays
inactive when an app has any Babel config other than the bare Expo preset, or a
custom `babelTransformerPath` such as `react-native-svg-transformer`, so the apps
have NO `babel.config.js` and no SVG transformer: `@/` resolves through
`tsconfig.json` paths, `babel-preset-expo` adds the worklets plugin and the
`import.meta` transform itself, and an SVG icon is a committed component, never
an imported `.svg`. Production exports (`NODE_ENV=production`) stay on Babel,
because Noxcturnal keeps the requires of dead platform branches and pulls
native-only packages into the web bundle. Run an export with `LOG_EVENTS=<file>`
to see which files fall back to Babel and why (`transform:noxcturnal:fallback`).

Material donation transport, payer authorization and retry behavior are documented
in `docs/material-transports.md`. Its FAIR cents differ from Mercaria's money scale;
consumers use the owning SDK formatter. Contracts, SDK and the legacy backend
route schemas share one Zod 4 copy.
