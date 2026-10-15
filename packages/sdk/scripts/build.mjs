import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { rollup } from 'rollup';
import { dts } from 'rollup-plugin-dts';
const external = ['zod', '@oxy.so/core'];
await mkdir('dist', { recursive: true });
for (const [format, extension] of [
  ['esm', 'js'],
  ['cjs', 'cjs'],
]) {
  await build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    platform: 'neutral',
    target: 'es2022',
    format,
    external,
    outfile: `dist/index.${extension}`,
  });
}
const bundle = await rollup({
  input: 'src/index.ts',
  external: (id) => external.some((name) => id === name || id.startsWith(`${name}/`)),
  plugins: [dts({ respectExternal: true })],
});
const { output } = await bundle.generate({ format: 'es' });
await bundle.close();
await writeFile('dist/index.d.ts', output[0].code);
await copyFile('dist/index.d.ts', 'dist/index.d.cts');
