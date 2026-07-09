#!/usr/bin/env node
/**
 * run-unit-tests.mjs — runs every test/unit/*.test.mjs in a child process
 * and aggregates exit codes. No test-framework dependency: each test file is
 * a standalone `node <file>` script built on test/unit/harness.mjs.
 *
 * Run: npm run test:unit   (or: node test/unit/run-unit-tests.mjs)
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const unitDir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(unitDir).filter(f => f.endsWith('.test.mjs')).sort();

if (files.length === 0) {
  console.error('No *.test.mjs files found in test/unit/');
  process.exit(1);
}

console.log(`Running ${files.length} unit test file(s)\n`);

let failures = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, [join(unitDir, file)], { stdio: 'inherit' });
  if (result.status !== 0) {
    failures++;
    console.error(`\n✗ ${file} exited with code ${result.status}`);
  }
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
if (failures > 0) {
  console.error(`UNIT TESTS FAILED: ${failures}/${files.length} file(s) had failures`);
  process.exit(1);
}
console.log(`UNIT TESTS PASSED: ${files.length}/${files.length} files`);
