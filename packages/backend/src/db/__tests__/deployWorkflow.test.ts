/**
 * The deploy can actually apply migrations — asserted against the real files.
 *
 * Before this, it could not, and nothing said so. The image shipped a single
 * bundled `dist/index.js`; `db/migrate.ts` was not an entry point and the `.sql`
 * files were never copied, so there was no way to migrate the production
 * database from the image that contains the migrations. The deploy workflow did
 * not try, either. A release therefore shipped code and left its schema behind,
 * and reported success — the failure mode this file exists to keep closed.
 *
 * Every assertion here links TWO files that must agree and whose disagreement is
 * SILENT: a build that stops emitting the migrator still produces a working
 * server; a Dockerfile that copies the SQL to the wrong place still produces a
 * bootable image; a workflow grepping the wrong directory still reports "no post
 * migration" and skips a drop forever. None of those fails any other test, and
 * none of them fails at build time — they fail at a deploy, against production.
 *
 * These are string assertions over configuration, which is the weakest kind of
 * test, so each one is written to fail LOUDLY on the specific edit that would
 * break it rather than to match loosely. Where a value is owned by `@oxyhq/db`
 * or by `migrate.ts`, it is IMPORTED and compared, never respelled.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POST_PHASE_GREP_PATTERN } from '@oxyhq/db/migrate';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../migrate';

/** `packages/backend/src/db/__tests__` → the repository root. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

const read = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8');

const WORKFLOW_PATH = '.github/workflows/deploy-aws.yml';
const SCRIPT_PATH = '.github/scripts/run-migration-task.sh';
const DOCKERFILE_PATH = 'Dockerfile';
const BUILD_PATH = 'packages/backend/build.ts';

/**
 * The command the migration task runs, and the one thing every other assertion
 * in this file is ultimately about: this exact path must exist in the image.
 */
const EMITTED_MIGRATOR = 'packages/backend/dist/db/migrate.js';

describe('the deploy can apply migrations', () => {
  it('bundles the migrator as its own entry point', () => {
    const build = read(BUILD_PATH);
    // The source entry. Without it esbuild emits only the server and the image
    // has no migrator at all — which is the state this whole file was written
    // for, and it passed every other test in the suite.
    expect(build).toContain("'src/db/migrate.ts'");
    // `outdir`, not `outfile`: two entry points cannot share an outfile, and
    // switching back to one silently drops the second.
    //
    // Matched as the config KEY (`outdir:`) rather than the bare word, because
    // both words appear in this file's own prose explaining the choice — the
    // first draft asserted on the word and failed on the comment beside it.
    expect(build).toMatch(/^\s*outdir:/m);
    expect(build).not.toMatch(/^\s*outfile:/m);
  });

  it('asserts both entry points were emitted, and copies the SQL where the migrator looks for it', () => {
    const dockerfile = read(DOCKERFILE_PATH);

    // A missing migrator must fail the BUILD, not the deploy: the server bundle
    // would still be present and perfectly functional, so nothing else notices.
    expect(dockerfile).toContain(`test -f ${EMITTED_MIGRATOR}`);

    // `migrate.ts` resolves its folder relative to its OWN directory, so the
    // emitted `dist/db/migrate.js` reads `dist/db/migrations`. Copying anywhere
    // else produces an image whose migrator starts, finds an empty journal, and
    // reports success having applied nothing.
    expect(dockerfile).toContain('packages/backend/dist/db/migrations');
    expect(dockerfile).toContain('packages/backend/src/db/migrations');
  });

  it('runs the emitted migrator, by the path the build actually produces', () => {
    const script = read(SCRIPT_PATH);
    expect(script).toContain(EMITTED_MIGRATOR);
    // Both guards the migrator itself enforces are supplied by the caller. A
    // phase is mandatory (there is no default, because guessing applies
    // destructive DDL against a live image) and `--target-database` is what
    // stops a mistyped connection string migrating another Oxy app's database
    // on the server they share.
    expect(script).toContain('--target-database=');
    expect(script).toContain('--phase=');
  });

  it('fails the deploy on a migration that did not succeed', () => {
    const script = read(SCRIPT_PATH);
    // `aws ecs run-task` exits 0 as soon as the task is ACCEPTED, so the CLI's
    // exit code says nothing about whether the migration ran. These three are
    // what turn a failed migration into a failed deploy.
    expect(script).toContain('aws ecs wait tasks-stopped');
    expect(script).toContain('exitCode');
    // A container that never STARTED has no exit code — `None`, not 0. Reading
    // that as success is the easiest way to ship an unmigrated database.
    expect(script).toContain('"None"');
  });

  it('greps for the post-phase marker with the pattern @oxyhq/db exports', () => {
    const workflow = read(WORKFLOW_PATH);
    // Imported, never respelled. A local copy of this pattern drifts from the
    // library the day the marker syntax changes, and the drift reads as "this
    // release has no post migration" — so the drop is skipped, silently, and
    // the next release's `pre` blocks behind it.
    expect(workflow).toContain(POST_PHASE_GREP_PATTERN);
  });

  it('greps the directory the migrator actually reads', () => {
    const workflow = read(WORKFLOW_PATH);
    // Derived from `MIGRATIONS_FOLDER` rather than typed out: if the migrations
    // ever move, this fails instead of the workflow quietly grepping an empty
    // path and concluding there is no post migration to apply.
    const folder = relative(REPO_ROOT, MIGRATIONS_FOLDER).split(sep).join('/');
    expect(folder).toBe('packages/backend/src/db/migrations');
    expect(workflow).toContain(folder);
  });

  it('serialises deploys and NEVER cancels one that is already running', () => {
    const workflow = read(WORKFLOW_PATH);

    // The migrator takes no lock — `@oxyhq/db`'s runner says so under a
    // heading reading "WHAT THIS DELIBERATELY DOES NOT DO", and it was
    // measured: two runs started together against one fresh database both
    // logged "Applying 1 migration(s)", one exited 0 and the other exited 1 on
    // an already-applied statement. So this workflow is the interlock.
    expect(workflow).toMatch(/^concurrency:/m);
    expect(workflow).toMatch(/^\s+group: deploy-aws-/m);

    // The load-bearing half, and the one somebody will "tidy". Cancelling a
    // run between `run-task` and its exit-code check orphans a live migration
    // task and reports nothing about it; cancelling mid-rollout is itself what
    // triggers an ECS rollback to the revision the cancelled run captured at
    // its start. `true` reads like an optimisation and is the opposite here.
    expect(workflow).toMatch(/^\s+cancel-in-progress: false$/m);
    expect(workflow).not.toMatch(/^\s+cancel-in-progress: true$/m);
  });

  it('runs the pre phase before the rollout and the post phase after it', () => {
    const workflow = read(WORKFLOW_PATH);
    const pre = workflow.indexOf('run-migration-task.sh pre');
    const rollout = workflow.indexOf('aws ecs update-service');
    const post = workflow.indexOf('run-migration-task.sh post');

    // Vacuity floor: an ordering assertion over indices that are all -1 passes
    // trivially, and a renamed script would produce exactly that.
    expect(pre).toBeGreaterThan(-1);
    expect(rollout).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(-1);

    // The ordering IS the phase split. `pre` is additive and must land while the
    // previous image still serves; `post` drops and narrows, each statement
    // breaking a write that image performs, so it must wait for the new one.
    expect(pre).toBeLessThan(rollout);
    expect(rollout).toBeLessThan(post);
  });
});
