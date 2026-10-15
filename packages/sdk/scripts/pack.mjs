import { mkdtemp, cp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const destination = resolve(process.argv[2] ?? '../../.artifacts');
await mkdir(destination, { recursive: true });
const staging = await mkdtemp(join(tmpdir(), 'moovo-sdk-'));
try {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  delete manifest.devDependencies;
  delete manifest.scripts;
  await writeFile(join(staging, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await cp('dist', join(staging, 'dist'), { recursive: true });
  await cp('README.md', join(staging, 'README.md'));
  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', destination], {
    cwd: staging,
    stdio: 'inherit',
  });
} finally {
  await rm(staging, { recursive: true, force: true });
}
