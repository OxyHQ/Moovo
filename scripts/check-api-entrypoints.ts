/**
 * A failed start of either API entrypoint must END THE PROCESS NON-ZERO, and a
 * good one must start, serve and stop cleanly — under BUN, the runtime the
 * production image ships.
 *
 * Executes the BUILT artefacts the way the image runs them —
 * `bun packages/backend/dist/index.js` (the image's CMD) and
 * `bun packages/backend/dist/db/migrate.js` (the deploy's one-shot task, whose
 * exit code `.github/scripts/run-migration-task.sh` reads) — never `src/`,
 * which is a different file from the bundle the image ships.
 *
 * Why it matters on a runtime change: ECS and the deploy read nothing but exit
 * codes. A migrator that exits 0 after refusing, or a server whose failed listen
 * leaves a live process, is a red deploy reported green. Bun and Node agree on
 * every scenario below (measured on 2026-10-12); this keeps it that way.
 *
 * Every failure scenario asserts BOTH the exit code and a log line proving the
 * process reached the failure being tested: a module that cannot even load also
 * exits non-zero and would otherwise satisfy the check vacuously. The positive
 * controls boot the server against a real database and shut it down with
 * SIGTERM, and run the migrator to its last line, so "non-zero" cannot be
 * explained by "this artefact never runs".
 *
 * Usage: `bun run check:api-entrypoints` (builds first). Requires
 * `MOOVO_ENTRYPOINT_DATABASE_URL`: a throwaway database with PostGIS installed,
 * e.g. the `moovo` database of docker-compose.postgres.yml.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import postgres from 'postgres';

const ROOT = join(import.meta.dir, '..');
const SERVER = 'packages/backend/dist/index.js';
const MIGRATOR = 'packages/backend/dist/db/migrate.js';
// The image's runtime. Override only to compare runtimes, e.g. RUNTIME_BINARY=node.
const RUNTIME = process.env.RUNTIME_BINARY || 'bun';

interface Outcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  timedOut: boolean;
}

interface Run {
  child: ChildProcess;
  done: Promise<Outcome>;
  output: () => string;
}

function start(argv: string[], env: Record<string, string>, timeoutMs: number): Run {
  // Inherit nothing that could decide the scenario: PATH and HOME only, then
  // what the scenario sets. A developer's DATABASE_URL, REDIS_URL or PORT must
  // not leak in.
  const child = spawn(RUNTIME, argv, {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_ENV: 'production',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    output += chunk;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  const done = new Promise<Outcome>((resolve, reject) => {
    child.on('error', reject);
    // 'close', not 'exit': 'exit' can precede the last piped chunk.
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output, timedOut });
    });
  });
  return { child, done, output: () => output };
}

async function listenOnFreePort(): Promise<{ port: number; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      if (typeof address === 'object' && address) resolve({ port: address.port, server });
      else reject(new Error('no port'));
    });
  });
}

const failures: string[] = [];

function check(scenario: string, condition: boolean, message: string, outcome?: Outcome): void {
  if (condition) return;
  failures.push(`${scenario}: ${message}`);
  if (outcome) {
    console.error(`--- ${scenario}: output (last 40 lines) ---`);
    console.error(outcome.output.split('\n').slice(-40).join('\n'));
  }
}

/** A failure: non-zero, not by timeout, after reaching every `reached` line. */
async function expectFailure(
  scenario: string,
  argv: string[],
  env: Record<string, string>,
  reached: string[],
): Promise<void> {
  const outcome = await start(argv, env, 20_000).done;
  check(scenario, !outcome.timedOut, 'still running after 20 s instead of exiting', outcome);
  check(
    scenario,
    outcome.code !== 0,
    `exited with code ${outcome.code} (signal ${outcome.signal}); a failure must be non-zero`,
    outcome,
  );
  for (const line of reached) {
    check(scenario, outcome.output.includes(line), `never logged ${JSON.stringify(line)}`, outcome);
  }
  console.log(`${scenario}: exit ${outcome.code}${outcome.timedOut ? ' (timed out)' : ''}`);
}

async function waitForReady(port: number, run: Run, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
      if (response.ok) return true;
    } catch {
      // not listening yet
    }
    if (run.child.exitCode !== null) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** A dry run must not initialize the ledger or change its recorded progress. */
async function migrationState(databaseUrl: string): Promise<string> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    return await sql.begin('read only', async (tx) => {
      const relations = await tx`
        SELECT n.nspname, c.relname, c.relkind
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%' ORDER BY 1, 2, 3`;
      const ledger = relations.some(
        (row) => row.nspname === 'drizzle' && row.relname === '__drizzle_migrations',
      )
        ? await tx`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`
        : [];
      return JSON.stringify({ relations, ledger });
    });
  } finally {
    await sql.end();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.MOOVO_ENTRYPOINT_DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      '::error::MOOVO_ENTRYPOINT_DATABASE_URL is required (the positive controls run for real).',
    );
    process.exit(1);
  }
  for (const entry of [SERVER, MIGRATOR]) {
    if (!existsSync(join(ROOT, entry))) {
      console.error(`::error::${entry} does not exist; run \`bun run build:backend\` first.`);
      process.exit(1);
    }
  }
  // The image carries the SQL next to the migrator (the Dockerfile's copy step);
  // the build does not, so mirror that step here.
  cpSync(
    join(ROOT, 'packages/backend/src/db/migrations'),
    join(ROOT, 'packages/backend/dist/db/migrations'),
    { recursive: true },
  );
  const targetDatabase = new URL(databaseUrl).pathname.slice(1);

  // 1. The listen failure the server handles: its port is taken. Only a
  //    process that EXITS lets ECS replace the task; one left alive listening
  //    on nothing just fails health checks until something kills it.
  const occupied = await listenOnFreePort();
  await expectFailure(
    'server: port in use',
    [SERVER],
    { DATABASE_URL: databaseUrl, PORT: String(occupied.port) },
    ['EADDRINUSE', 'Port already in use'],
  );
  occupied.server.close();

  // 2. Positive control: the same artefact boots, answers /health/ready (the
  //    ALB's probe, a real `select 1`), and SIGTERM — what ECS sends on a
  //    rollout — runs the graceful shutdown to exit 0.
  const free = await listenOnFreePort();
  const port = free.port;
  await new Promise<void>((resolve) => free.server.close(() => resolve()));
  const run = start([SERVER], { DATABASE_URL: databaseUrl, PORT: String(port) }, 60_000);
  const ready = await waitForReady(port, run, 20_000);
  check('server: boots and shuts down', ready, `never answered /health/ready on port ${port}`);
  run.child.kill('SIGTERM');
  const outcome = await run.done;
  check('server: boots and shuts down', !outcome.timedOut, 'did not exit after SIGTERM', outcome);
  check(
    'server: boots and shuts down',
    outcome.code === 0,
    `a graceful shutdown exited with code ${outcome.code} (signal ${outcome.signal})`,
    outcome,
  );
  check(
    'server: boots and shuts down',
    outcome.output.includes('Graceful shutdown complete'),
    'never logged "Graceful shutdown complete"',
    outcome,
  );
  console.log(`server: boots and shuts down: ready=${ready}, exit ${outcome.code}`);

  // 3. The migrator refuses a run with no --phase, and says why.
  await expectFailure(
    'migrator: missing --phase',
    [MIGRATOR, `--target-database=${targetDatabase}`],
    { DATABASE_URL: databaseUrl },
    ['Refusing to migrate: no --phase'],
  );

  // 4. The migrator refuses a database other than the one it was told to
  //    migrate — the guard that keeps a wrong DATABASE_URL off another app's
  //    database on the shared server — and the deploy must see that as failure.
  await expectFailure(
    'migrator: wrong target database',
    [MIGRATOR, '--target-database=not-this-database', '--phase=pre'],
    { DATABASE_URL: databaseUrl },
    ['Refusing to migrate: the run expects "not-this-database"'],
  );

  // 5. Positive control: inspect the entire cold-start chain without writing.
  // A fresh ledger cannot run a later pre migration past an earlier post;
  // that rollout guard remains enforced by the production runner. The image
  // smoke separately applies the previous release then candidate pre/boot/post.
  const beforeDryRun = await migrationState(databaseUrl);
  const dryRun = await start(
    [MIGRATOR, `--target-database=${targetDatabase}`, '--phase=all', '--dry-run'],
    { DATABASE_URL: databaseUrl },
    60_000,
  ).done;
  check('migrator: dry run', dryRun.code === 0, `exited with code ${dryRun.code}`, dryRun);
  check(
    'migrator: dry run',
    /migration\(s\)|No migrations to apply/.test(dryRun.output),
    'never reached its report',
    dryRun,
  );
  check(
    'migrator: dry run',
    (await migrationState(databaseUrl)) === beforeDryRun,
    'changed database relations or migration ledger',
  );
  console.log(`migrator: dry run: exit ${dryRun.code}`);

  if (failures.length > 0) {
    for (const failure of failures) console.error(`::error::${failure}`);
    process.exit(1);
  }
  console.log(
    `Both built API entrypoints exit non-zero on every failure tested, and 0 when they succeed (runtime: ${RUNTIME}).`,
  );
}

await main();
