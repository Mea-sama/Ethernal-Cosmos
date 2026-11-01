// Gate: every TEST-ID in docs/server-feature-spec.md needs a conformance test and vice versa.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specPath = path.join(root, 'docs/server-feature-spec.md');
const testDir = path.join(root, 'server/test/conformance');
const ID = 'TEST-[A-Z][A-Z0-9]*-\\d{2,}';

const specIds = new Set();
for (const line of fs.readFileSync(specPath, 'utf8').split('\n')) {
  const m = line.match(new RegExp(`^\\|\\s*(${ID})\\s*\\|`));
  if (m) {
    if (specIds.has(m[1])) console.error(`Duplicate spec ID ${m[1]}`);
    specIds.add(m[1]);
  }
}

const testIds = new Map();
const titleRe = new RegExp(`\\bit(?:\\.\\w+)?\\(\\s*(['"\`])(${ID})\\b`, 'g');
for (const file of fs.readdirSync(testDir).filter((f) => f.endsWith('.test.ts'))) {
  const src = fs.readFileSync(path.join(testDir, file), 'utf8');
  for (const m of src.matchAll(titleRe)) {
    const files = testIds.get(m[2]) ?? [];
    files.push(file);
    testIds.set(m[2], files);
  }
}

const problems = [];
for (const id of specIds) if (!testIds.has(id)) problems.push(`spec ID without test: ${id}`);
for (const [id, files] of testIds) {
  if (!specIds.has(id)) problems.push(`test uses unknown ID: ${id} (${files.join(', ')})`);
  if (files.length > 1) problems.push(`ID used by more than one test: ${id} (${files.join(', ')})`);
}
if (specIds.size === 0) problems.push('no TEST-IDs found in the spec table');

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log(`✔ conformance: ${specIds.size} spec IDs, all covered by tests`);
