#!/usr/bin/env bash
# Boot the built API image the way ECS runs it, against a throwaway Postgres,
# and fail unless the production runtime (Bun as PID 1, the image's own user and
# entrypoint) can:
#   1. apply both migrator phases with the command run-migration-task.sh sends,
#   2. mint an Oxy service token from a workload identity with the production
#      @oxy.so/core (check-workload-attestation.mjs — the path an extensionless
#      dynamic import once broke under Node's ESM resolver),
#   3. serve /health/ready with 200 from the image's default CMD,
#   4. turn SIGTERM (`docker stop`, as ECS does on a rollout) into the graceful
#      shutdown and exit 0,
# and first, through check-api-image-files.sh, that the runtime user cannot
# write the app files and the runtime node_modules is the API's closure only.
# The migrator and the server below then run with /app read-only to them, so
# a write the runtime needs under /app would fail here.
# A unit suite cannot see any of these: they are properties of the image.
#
# Env: IMAGE (the built image), DATABASE_URL (a throwaway database named
# `moovo` with PostGIS installed, which the migrator requires), PORT (optional).
set -euo pipefail

: "${IMAGE:?IMAGE required}"
: "${DATABASE_URL:?DATABASE_URL required (a throwaway database named moovo)}"
PORT="${PORT:-3001}"
NAME="moovo-api-smoke-$$"
HERE="$(cd "$(dirname "$0")" && pwd)"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

bash "$HERE/check-api-image-files.sh"

for phase in pre post; do
  docker run --rm --network host -e DATABASE_URL "$IMAGE" \
    bun packages/backend/dist/db/migrate.js --target-database=moovo --phase="$phase"
done

# Mounted INTO /app so `@oxy.so/core` resolves from the image's own
# node_modules, exactly as the bundle at /app/packages/backend/dist does.
docker run --rm --network host \
  -v "$HERE/check-workload-attestation.mjs:/app/check-workload-attestation.mjs:ro" \
  "$IMAGE" bun check-workload-attestation.mjs

docker run -d --name "$NAME" --network host -e DATABASE_URL -e PORT="$PORT" "$IMAGE" >/dev/null

ready=
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/health/ready" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != true ]; then
    break
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  docker logs "$NAME" || true
  echo "::error::the API image never answered /health/ready"
  exit 1
fi

# PID 1 must be Bun running the bundle: the entrypoint execs the CMD, so a
# wrapper left at PID 1 would have to forward the SIGTERM tested below, and a
# `node` here would mean the image is not the one this script was written for.
pid1=$(docker exec "$NAME" cat /proc/1/cmdline | tr '\0' ' ')
case "$pid1" in
  "bun packages/backend/dist/index.js "*) ;;
  *)
    echo "::error::PID 1 is '$pid1', expected 'bun packages/backend/dist/index.js'"
    exit 1
    ;;
esac
uid=$(docker exec "$NAME" id -u)
if [ "$uid" != 1000 ]; then
  echo "::error::the API runs as uid $uid; the image must run as its unprivileged bun user (uid 1000)"
  exit 1
fi

docker stop -t 35 "$NAME" >/dev/null
exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
logs=$(docker logs "$NAME" 2>&1)
if [ "$exit_code" != 0 ] || ! grep -q 'Graceful shutdown complete' <<<"$logs"; then
  printf '%s\n' "$logs"
  echo "::error::SIGTERM did not end in a graceful exit 0 (exit code $exit_code)"
  exit 1
fi

echo "API image smoke passed: read-only app files, migrations, workload attestation, /health/ready, PID 1 = Bun (uid $uid), graceful SIGTERM"
