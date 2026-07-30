import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/index.js',
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
