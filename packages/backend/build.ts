import * as esbuild from 'esbuild';

await esbuild.build({
  /**
   * TWO entry points, and the second is not optional.
   *
   * `src/db/migrate.ts` is the one-shot the deploy runs before and after the
   * rollout (`.github/workflows/deploy-aws.yml`). It cannot be invoked the way a
   * developer does — `bun src/db/migrate.ts` — because the runtime image ships
   * neither bun nor `src/`, only node and `dist/`. Without this entry there is
   * simply no way to migrate the production database from the image that
   * carries the migrations, and the failure is silent in the worst direction:
   * the deploy succeeds, the new code serves, and its tables do not exist.
   *
   * `outdir` rather than `outfile` because there are two: esbuild takes the
   * entry points' common ancestor (`src/`) as the base, so these land exactly at
   * `dist/index.js` and `dist/db/migrate.js`. `migrate.ts` runs `main()` under
   * `import.meta.main`, which esbuild preserves, so the emitted file runs on
   * plain `node <path>`.
   *
   * `db/migrate.ts` resolves its SQL folder relative to its OWN directory
   * (`import.meta.url`), so the emitted `dist/db/migrate.js` looks for
   * `dist/db/migrations` — which is where the Dockerfile puts the `.sql` files.
   * That resolution is depth-independent and therefore correct for both the
   * `src/` and `dist/` layouts without either knowing about the other.
   *
   * Code splitting is deliberately left OFF (esbuild's default): each entry is
   * self-contained, so the migrator cannot fail at container start on a missing
   * shared chunk — the one failure that would strike exactly when a deploy is
   * mid-flight.
   */
  entryPoints: [
    'src/index.ts',
    'src/db/migrate.ts',
  ],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outdir: 'dist',
  // Keep every node_modules dependency external EXCEPT @moovo/* — first-party
  // workspace packages (e.g. shared-types) are inlined so the runtime image has
  // no dependency on their dist or their build-time devDependencies.
  //
  // @oxyhq/* MUST stay external. The @oxyhq/crowdsource* packages are published
  // as CommonJS, and inlining CJS into this ESM bundle rewrites each of their
  // internal require() calls into an esbuild shim that throws the moment it
  // runs — the container died at startup with
  //   Error: Dynamic require of "zod" is not supported
  // and the API could not deploy (2026-07-30). Node's own ESM loader imports
  // those CJS packages correctly, so leave the resolution to Node; the runtime
  // image ships node_modules (see the Dockerfile), so they resolve there.
  plugins: [{
    name: 'externalize-third-party',
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (args.path.startsWith('@moovo/')) return undefined;
        return { path: args.path, external: true };
      });
    },
  }],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

console.log('✅ Build complete');
