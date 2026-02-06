/**
 * Test helpers - temp directories, mocking, and fixtures.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Create a temporary directory for test isolation.
 * Returns { dir, cleanup } where cleanup removes it.
 */
function tmpDir(prefix = 'hive-test-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return {
        dir,
        cleanup() {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    };
}

/**
 * Create a Hive instance with mocked Docker commands.
 * No real Docker calls are made.
 */
function createMockHive(hiveDir, overrides = {}) {
    const { Hive } = require('../index.js');

    const hive = new Hive({ hiveDir, useSudo: false });

    // Track all docker calls for assertions
    hive._dockerCalls = [];
    hive._dockerAsyncCalls = [];

    // Default mock: _docker returns empty string
    const origDocker = hive._docker.bind(hive);
    hive._docker = function (cmd) {
        hive._dockerCalls.push(cmd);
        if (overrides._docker) {
            return overrides._docker(cmd);
        }
        // Default mocked responses
        if (cmd.includes('image inspect')) return '[]';
        if (cmd.startsWith('run ')) return 'abc123containerid\n';
        if (cmd.includes('inspect -f')) return "'running'\n";
        if (cmd.startsWith('logs ')) return 'mock container logs\n';
        if (cmd.startsWith('stop ')) return '';
        if (cmd.startsWith('rm ')) return '';
        if (cmd.startsWith('build ')) return 'built\n';
        return '';
    };

    const origDockerAsync = hive._dockerAsync.bind(hive);
    hive._dockerAsync = function (args) {
        hive._dockerAsyncCalls.push(args);
        if (overrides._dockerAsync) {
            return overrides._dockerAsync(args);
        }
        // Return a mock child process
        return { pid: 12345, on() {}, stdout: { on() {} }, stderr: { on() {} } };
    };

    return hive;
}

/**
 * Write a minion workspace with meta.json, STATUS, and optional output.
 */
function writeMinionFixture(minionsDir, name, opts = {}) {
    const minionDir = path.join(minionsDir, name);
    fs.mkdirSync(minionDir, { recursive: true });
    fs.mkdirSync(path.join(minionDir, 'output'), { recursive: true });

    const meta = {
        name,
        createdAt: opts.createdAt || '2026-01-01T00:00:00.000Z',
        task: opts.task || 'Test task for ' + name,
        status: opts.status || 'running',
        containerId: opts.containerId || 'sha256:abc123',
        ...opts.extraMeta
    };
    fs.writeFileSync(path.join(minionDir, 'meta.json'), JSON.stringify(meta, null, 2));

    if (opts.taskStatus) {
        fs.writeFileSync(path.join(minionDir, 'STATUS'), opts.taskStatus);
    }

    if (opts.output) {
        fs.writeFileSync(path.join(minionDir, 'output', 'claude-output.log'), opts.output);
    }

    if (opts.taskContent) {
        fs.writeFileSync(path.join(minionDir, 'TASK.md'), opts.taskContent);
    }

    return minionDir;
}

/**
 * Capture console output during a function call.
 */
function captureConsole(fn) {
    const logs = [];
    const errors = [];
    const warns = [];
    const origLog = console.log;
    const origErr = console.error;
    const origWarn = console.warn;

    console.log = (...args) => logs.push(args.join(' '));
    console.error = (...args) => errors.push(args.join(' '));
    console.warn = (...args) => warns.push(args.join(' '));

    try {
        const result = fn();
        return { result, logs, errors, warns };
    } finally {
        console.log = origLog;
        console.error = origErr;
        console.warn = origWarn;
    }
}

module.exports = { tmpDir, createMockHive, writeMinionFixture, captureConsole };
