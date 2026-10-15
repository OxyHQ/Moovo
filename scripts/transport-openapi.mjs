import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openapi } from '../packages/contracts/dist/index.js';
const path = new URL('../packages/contracts/openapi.json', import.meta.url);
const expected = `${JSON.stringify(openapi(), null, 2)}\n`;
if (process.argv.includes('--write')) {
  await writeFile(path, expected);
  execFileSync('bun', ['x', 'biome', 'format', '--write', fileURLToPath(path)]);
} else if (JSON.stringify(JSON.parse(await readFile(path, 'utf8'))) !== JSON.stringify(openapi()))
  throw new Error(
    'Transport OpenAPI is stale; build contracts and run bun scripts/transport-openapi.mjs --write',
  );
