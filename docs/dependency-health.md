# Dependency health

Run `bun run doctor:oxy` to compare direct `@oxy.so/*` dependencies with npm and
detect duplicate Oxy versions in `bun.lock`. CI runs the same read-only check;
it never edits manifests or installs updates.

Dependabot proposes weekly GitHub Actions updates. JavaScript dependencies use
the Bun lockfile, so package updates are applied with `bun update`, tested and
reviewed before merge. Runtime auto-updates and `latest` ranges are not used.
