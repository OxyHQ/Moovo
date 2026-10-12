/**
 * `vi.stubEnv` / `vi.stubGlobal` semantics by hand, for test files that run
 * under vitest AND under `bun test` (the production runtime; see the backend's
 * `test:bun` script). bun:test's `vi` has neither, nor `vi.hoisted`, and its
 * `vi.mock` is not hoisted, so a dual-runner file registers its mocks before a
 * DYNAMIC import of the module under test and stubs env and globals with these.
 */

const originalEnv = new Map<string, string | undefined>();

/** Sets (or, with `undefined`, deletes) an env var until {@link unstubAllEnvs}. */
export function stubEnv(name: string, value: string | undefined): void {
  if (!originalEnv.has(name)) originalEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Restores every variable {@link stubEnv} touched to its value before the first stub. */
export function unstubAllEnvs(): void {
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originalEnv.clear();
}

const globals = globalThis as Record<string, unknown>;
const originalGlobals = new Map<string, { present: boolean; value: unknown }>();

/** Replaces a global until {@link unstubAllGlobals}. */
export function stubGlobal(name: string, value: unknown): void {
  if (!originalGlobals.has(name)) {
    originalGlobals.set(name, { present: name in globals, value: globals[name] });
  }
  globals[name] = value;
}

/** Restores every global {@link stubGlobal} replaced. */
export function unstubAllGlobals(): void {
  for (const [name, { present, value }] of originalGlobals) {
    if (present) globals[name] = value;
    else delete globals[name];
  }
  originalGlobals.clear();
}

/**
 * The value `promise` rejects with; throws if it resolves instead.
 *
 * `expect(await rejectionOf(p)).toSatisfy(...)` in place of
 * `await expect(p).rejects.toSatisfy(...)`, which bun:test does not await.
 */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject, and it resolved');
}
