#!/usr/bin/env bash
# What the built API image ships and what its runtime user may change. Needs no
# database, so it runs on both architectures: inside smoke-api-image.sh (amd64,
# booted against Postgres) and in CI's linux/arm64 build, the platform the
# deploy pushes.
#
#   1. the image runs as `bun` (uid 1000), not root;
#   2. that user cannot write, create or delete anything under /app (the app
#      files are root-owned, no --chown), and can write the temp dir the
#      migrator stages its journal prefix in;
#   3. the runtime node_modules is the API's production closure only: no Expo,
#      React Native, Metro, TypeScript, esbuild or test tooling;
#   4. the production install ran no lifecycle scripts (--ignore-scripts) and
#      the one native addon in the closure, msgpackr-extract, still loads from
#      its prebuilt binary.
#
# Env: IMAGE (the built image).
set -euo pipefail

: "${IMAGE:?IMAGE required}"

# The image's own USER, entrypoint replaced by a shell: these are properties of
# the files and the user, not of the server process.
docker run --rm -i --entrypoint sh "$IMAGE" -s <<'EOF'
set -eu
fail() { echo "::error::$*"; exit 1; }

[ "$(id -u)" = 1000 ] || fail "the image runs as uid $(id -u), expected 1000 (bun)"
[ "$(id -un)" = bun ] || fail "the image runs as $(id -un), expected bun"
case " $(id -G) " in *" 0 "*) fail "the runtime user is in the root group" ;; esac

# Ownership and mode: every path under /app is root's and nobody else may write
# it (a symlink's own mode is always 777 and means nothing, so it is skipped for
# the mode test; what it points at is checked where it lives).
bad=$(find /app \( ! -user root -o ! -group root -o \( ! -type l -perm -0002 \) \) -print | head -5)
[ -z "$bad" ] || fail "app files not root-owned and read-only to the runtime user: $bad"

# And the writes themselves, so the assertion does not rest on reading modes.
for probe in \
  "touch /app/probe" \
  "touch /app/packages/backend/dist/probe" \
  "touch /app/packages/backend/dist/db/migrations/probe.sql" \
  "mkdir /app/node_modules/probe" \
  ": >> /app/packages/backend/dist/index.js" \
  ": >> /app/packages/backend/dist/db/migrate.js" \
  ": >> /app/node_modules/express/package.json" \
  "rm -f /app/packages/backend/dist/index.js" \
  "mv /app/packages/backend/dist /app/packages/backend/dist-moved"; do
  if sh -c "$probe" 2>/dev/null; then
    fail "the runtime user could run: $probe"
  fi
done
[ -f /app/packages/backend/dist/index.js ] || fail "the bundle vanished during the write probes"

# The one place the process writes: the migrator's journal prefix (os.tmpdir()).
tmp=$(mktemp -d) || fail "the runtime user cannot create a directory in the temp dir"
echo ok > "$tmp/probe" && rm -rf "$tmp"

for absent in expo react-native react @expo @react-native metro typescript esbuild \
  vitest drizzle-kit @biomejs @swc pino-pretty; do
  [ ! -e "/app/node_modules/$absent" ] || fail "node_modules/$absent ships in the runtime image"
done
for present in express drizzle-orm postgres socket.io bullmq @oxy.so/core @oxy.so/db \
  @crowdsource.you/core msgpackr-extract; do
  [ -e "/app/node_modules/$present" ] || fail "node_modules/$present is missing from the runtime image"
done

cd /app
bun -e "import('msgpackr').then(m => process.exit(m.isNativeAccelerationEnabled ? 0 : 1), () => process.exit(2))" \
  || fail "msgpackr's native addon (msgpackr-extract prebuild) does not load"

echo "image files: uid $(id -u) ($(id -un)), /app read-only to it, /tmp writable," \
  "node_modules $(du -sh /app/node_modules | cut -f1) with $(ls /app/node_modules | wc -l) top-level entries," \
  "msgpackr native addon loaded"
EOF
