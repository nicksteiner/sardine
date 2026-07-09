/**
 * harness.mjs — tiny zero-dependency unit test harness for SARdine.
 *
 * Wraps node:assert/strict with an assertion counter so each test file can
 * prove its assertions actually executed (printed in the summary). No test
 * framework deps — plain `node test/unit/<file>.test.mjs` runs a suite.
 *
 * Usage:
 *   import { suite } from './harness.mjs';
 *   const { test, assert, run } = suite('my suite');
 *   test('name', async () => { assert.equal(1, 1); });
 *   await run(); // prints summary, sets process.exitCode = 1 on failure
 */

import { strict as nodeAssert } from 'node:assert';

export function suite(name) {
  const tests = [];
  let assertionCount = 0;

  // Counting proxy: every assert.* call (and bare assert()) bumps the counter
  // BEFORE the check runs, so failed assertions are counted as executed too.
  const assert = new Proxy(nodeAssert, {
    get(target, prop) {
      const orig = target[prop];
      if (typeof orig !== 'function') return orig;
      return (...args) => {
        assertionCount++;
        return orig.apply(target, args);
      };
    },
    apply(target, thisArg, args) {
      assertionCount++;
      return target(...args);
    },
  });

  /** assert |actual - expected| <= tolerance (for binned percentiles etc.) */
  function assertClose(actual, expected, tolerance, label = 'value') {
    assertionCount++;
    const diff = Math.abs(actual - expected);
    if (!(diff <= tolerance)) {
      throw new nodeAssert.AssertionError({
        message: `${label}: expected ${expected} ± ${tolerance}, got ${actual} (diff ${diff})`,
        actual,
        expected,
      });
    }
  }

  function test(testName, fn) {
    tests.push({ testName, fn });
  }

  async function run() {
    console.log(`\n━━━ ${name} ━━━`);
    let passed = 0;
    let failed = 0;

    for (const { testName, fn } of tests) {
      try {
        await fn();
        console.log(`  ✓ PASS  ${testName}`);
        passed++;
      } catch (err) {
        console.log(`  ✗ FAIL  ${testName}`);
        console.log(`          ${String(err.message).split('\n').join('\n          ')}`);
        failed++;
      }
    }

    console.log(`\n${name}: ${passed} passed, ${failed} failed, ${assertionCount} assertions executed`);
    if (failed > 0) process.exitCode = 1;
    return { passed, failed, assertions: assertionCount };
  }

  return { test, assert, assertClose, run };
}
