/**
 * Minimal test runner - no dependencies required.
 */

const suites = [];
let currentSuite = null;

function describe(name, fn) {
    const suite = { name, tests: [], beforeEachFn: null, afterEachFn: null, passed: 0, failed: 0, errors: [] };
    suites.push(suite);
    currentSuite = suite;
    fn();
    currentSuite = null;
}

function beforeEach(fn) {
    if (currentSuite) currentSuite.beforeEachFn = fn;
}

function afterEach(fn) {
    if (currentSuite) currentSuite.afterEachFn = fn;
}

function it(name, fn) {
    if (currentSuite) currentSuite.tests.push({ name, fn });
}

class AssertionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AssertionError';
    }
}

const assert = {
    equal(actual, expected, msg) {
        if (actual !== expected) {
            throw new AssertionError(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        }
    },
    deepEqual(actual, expected, msg) {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new AssertionError(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        }
    },
    ok(value, msg) {
        if (!value) {
            throw new AssertionError(msg || `Expected truthy, got ${JSON.stringify(value)}`);
        }
    },
    notOk(value, msg) {
        if (value) {
            throw new AssertionError(msg || `Expected falsy, got ${JSON.stringify(value)}`);
        }
    },
    throws(fn, expectedMsg) {
        let threw = false;
        let error;
        try { fn(); } catch (e) { threw = true; error = e; }
        if (!threw) {
            throw new AssertionError(`Expected function to throw`);
        }
        if (expectedMsg) {
            // Support both string and regex patterns
            if (expectedMsg instanceof RegExp) {
                if (!expectedMsg.test(error.message)) {
                    throw new AssertionError(`Expected error matching ${expectedMsg}, got "${error.message}"`);
                }
            } else if (!error.message.includes(expectedMsg)) {
                throw new AssertionError(`Expected error containing "${expectedMsg}", got "${error.message}"`);
            }
        }
        return error;
    },
    doesNotThrow(fn, msg) {
        try { fn(); } catch (e) {
            throw new AssertionError(msg || `Expected no throw, got: ${e.message}`);
        }
    },
    includes(haystack, needle, msg) {
        if (typeof haystack === 'string') {
            if (!haystack.includes(needle)) {
                throw new AssertionError(msg || `Expected "${haystack}" to include "${needle}"`);
            }
        } else if (Array.isArray(haystack)) {
            if (!haystack.includes(needle)) {
                throw new AssertionError(msg || `Expected array to include ${JSON.stringify(needle)}`);
            }
        }
    },
    match(value, pattern, msg) {
        if (!pattern.test(value)) {
            throw new AssertionError(msg || `Expected "${value}" to match ${pattern}`);
        }
    }
};

async function run() {
    let totalPassed = 0;
    let totalFailed = 0;

    for (const suite of suites) {
        console.log(`\n  ${suite.name}`);

        for (const test of suite.tests) {
            try {
                if (suite.beforeEachFn) suite.beforeEachFn();
                const result = test.fn();
                if (result && typeof result.then === 'function') {
                    await result;
                }
                if (suite.afterEachFn) suite.afterEachFn();
                suite.passed++;
                totalPassed++;
                console.log(`    \x1b[32m✓\x1b[0m ${test.name}`);
            } catch (err) {
                if (suite.afterEachFn) try { suite.afterEachFn(); } catch {}
                suite.failed++;
                totalFailed++;
                suite.errors.push({ test: test.name, error: err });
                console.log(`    \x1b[31m✗\x1b[0m ${test.name}`);
                console.log(`      \x1b[31m${err.message}\x1b[0m`);
            }
        }
    }

    console.log(`\n  \x1b[32m${totalPassed} passing\x1b[0m`);
    if (totalFailed > 0) {
        console.log(`  \x1b[31m${totalFailed} failing\x1b[0m\n`);
        process.exit(1);
    }
    console.log('');
}

module.exports = { describe, it, beforeEach, afterEach, assert, run };
