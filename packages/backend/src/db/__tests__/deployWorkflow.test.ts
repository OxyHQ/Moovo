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
import { parse as parseYaml } from 'yaml';
import { MIGRATIONS_FOLDER } from '../migrate';
import {
  POSTGRES_TESTS_REQUIRED_ENV,
  POSTGRES_TESTS_REQUIRED_VALUE,
  TEST_ADMIN_URL_ENV,
} from '../testDatabase';

/** `packages/backend/src/db/__tests__` → the repository root. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

const read = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8');

const WORKFLOW_PATH = '.github/workflows/deploy-aws.yml';
const SCRIPT_PATH = '.github/scripts/run-migration-task.sh';
const DOCKERFILE_PATH = 'Dockerfile';
const BUILD_PATH = 'packages/backend/build.ts';
const COMPOSE_FILE = 'docker-compose.postgres.yml';

/**
 * Only the parts of the workflow the assertions below reason about.
 *
 * Parsed with a real YAML parser rather than sliced out of the text: the one
 * assertion that must be JOB-SCOPED is the runner, because `deploy` is
 * legitimately on ARM while `test` must not be, and a whole-file string check
 * cannot tell those two apart.
 */
interface DeployWorkflowJob {
  'runs-on'?: string;
  needs?: string | string[];
  steps?: { name?: string; run?: string; env?: Record<string, string> }[];
}

interface DeployWorkflow {
  jobs?: Record<string, DeployWorkflowJob>;
}

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

  it('gates the rollout on a test job that actually runs the real-database suites', () => {
    // WHY THIS EXISTS, measured on 6f0dae4 before it did: this job ran
    // `bun run --filter @moovo/backend test` with no Postgres server and no
    // TEST_DATABASE_URL, so every `*.realdb.test.ts` suite took the
    // `describe.skip` branch. The exact command reported
    // `Tests 341 passed | 354 skipped (695)` and exited 0 in three seconds —
    // all 354 skipped tests were real-database tests, and the deploy was green.
    //
    // That is the expensive shape: the suites that exercise CHECKs, partial
    // uniques, triggers, `FOR UPDATE SKIP LOCKED` and `ON CONFLICT` no-op
    // semantics have no mocked counterpart, so skipping them removes the only
    // thing that can catch a statement the server rejects. `ci.yml` runs them,
    // but `ci.yml` is a different workflow: it going red stops nothing here.
    //
    // The assertions below are ordered by how SILENTLY each failure arrives.
    const workflow = parseYaml(read(WORKFLOW_PATH)) as DeployWorkflow;
    const jobs = workflow.jobs ?? {};

    // Vacuity floor. A parse that yielded an empty document, or a renamed job,
    // would otherwise make every lookup below undefined — and `undefined`
    // satisfies a surprising number of assertions written the obvious way.
    expect(Object.keys(jobs).sort()).toEqual(['deploy', 'test']);
    const testJob = jobs.test;
    const steps = testJob.steps ?? [];
    expect(steps.length).toBeGreaterThan(0);

    // SILENT FAILURE 1: `deploy` stops needing `test`. Every other assertion
    // here would still pass, about a job that no longer blocks the rollout.
    const needs = jobs.deploy.needs;
    expect(Array.isArray(needs) ? needs : [needs]).toContain('test');

    // SILENT FAILURE 2: the env lands on the wrong STEP. `env:` is per-step, so
    // setting it on the lint step or at job level-but-misindented leaves the
    // suite skipping while the workflow still mentions both variables — which
    // is why this is found by the step that RUNS the suite rather than by a
    // grep over the file.
    const TEST_COMMAND = 'bun run --filter @moovo/backend test';
    const testStepIndex = steps.findIndex((step) => (step.run ?? '').includes(TEST_COMMAND));
    expect(testStepIndex).toBeGreaterThan(-1);
    const testStepEnv = steps[testStepIndex].env ?? {};

    // SILENT FAILURE 3, the finding itself. Without this variable the suites
    // SKIP rather than fail, so every way the server can be unavailable — a
    // renamed variable, a moved port, an image that will not pull — produces a
    // green deploy over an untested database. Names imported from
    // `testDatabase.ts`, never respelled, so renaming the variable there fails
    // here instead of quietly disarming the requirement.
    expect(testStepEnv[TEST_ADMIN_URL_ENV]).toBeTruthy();
    // Compared to the arming VALUE, not merely present: the near-miss
    // `MOOVO_REQUIRE_POSTGRES_TESTS: 'true'` reads to a human as "required",
    // is accepted by YAML, and disarms the check completely.
    expect(testStepEnv[POSTGRES_TESTS_REQUIRED_ENV]).toBe(POSTGRES_TESTS_REQUIRED_VALUE);

    // A server has to be started, and started BEFORE the suite runs. Not a
    // silent failure while the variable above survives — it goes red — but the
    // two are removed together often enough to be worth pinning.
    const composeStepIndex = steps.findIndex((step) =>
      (step.run ?? '').includes(`docker compose -f ${COMPOSE_FILE} up`),
    );
    expect(composeStepIndex).toBeGreaterThan(-1);
    expect(composeStepIndex).toBeLessThan(testStepIndex);

    // The compose file is the single authority for the image pin — shared with
    // `ci.yml` and with a developer's laptop rather than restated in a
    // `services:` block. Read here so a rename fails this test rather than the
    // deploy.
    expect(read(COMPOSE_FILE)).toContain('postgis/postgis:');

    // The runner. `postgis/postgis:17-3.5` publishes exactly one platform,
    // linux/amd64 (measured 2026-08-11 with `docker manifest inspect`), so on
    // the `ubuntu-24.04-arm` runner this job used to use there is no way to
    // start the server at all. The mismatch with the arm64 `deploy` job is
    // therefore deliberate, and this is the assertion that says so to whoever
    // next tries to unify them.
    expect(testJob['runs-on']).toBeTruthy();
    expect(testJob['runs-on']).not.toMatch(/arm/);

    // Floor for the negative check above: "no arm runner here" is also what a
    // lookup against a mistyped key reports. The deploy job builds linux/arm64
    // natively and must stay on one, so the string is findable in this file —
    // if it is not, the check above is measuring nothing.
    expect(jobs.deploy['runs-on']).toMatch(/arm/);
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
