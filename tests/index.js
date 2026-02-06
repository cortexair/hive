#!/usr/bin/env node
/**
 * Test entry point - runs all test suites.
 */

const { run } = require('./runner');

console.log('\n  Hive Test Suite');
console.log('  ===============');

// Load all test files (order matters: core first, then CLI)
require('./hive.test');
require('./cli.test');

// Execute
run();
