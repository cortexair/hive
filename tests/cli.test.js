/**
 * Tests for CLI (cli.js) - argument parsing and command routing.
 *
 * Since cli.js runs as a script with side effects (creates a global Hive, calls main()),
 * we test the parseArgs logic inline and use child_process to test command routing.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { describe, it, beforeEach, afterEach, assert } = require('./runner');
const { tmpDir } = require('./helpers');

let tmp;

// ─── parseArgs (extracted logic) ─────────────────────────────────────

// Re-implement parseArgs here for unit testing since it's not exported from cli.js
function parseArgs(args) {
    const result = { _: [] };
    let i = 0;
    while (i < args.length) {
        if (args[i].startsWith('--')) {
            const key = args[i].slice(2);
            if (args[i + 1] && !args[i + 1].startsWith('-')) {
                result[key] = args[i + 1];
                i += 2;
            } else {
                result[key] = true;
                i++;
            }
        } else if (args[i] === '-f' && args[i + 1]) {
            result.file = args[i + 1];
            i += 2;
        } else {
            result._.push(args[i]);
            i++;
        }
    }
    return result;
}

describe('parseArgs', () => {
    it('parses positional arguments', () => {
        const result = parseArgs(['worker-1', 'do stuff']);
        assert.deepEqual(result._, ['worker-1', 'do stuff']);
    });

    it('parses --key value flags', () => {
        const result = parseArgs(['--name', 'worker-1']);
        assert.equal(result.name, 'worker-1');
    });

    it('parses boolean --flags', () => {
        const result = parseArgs(['--keep-alive', '--verbose']);
        assert.equal(result['keep-alive'], true);
        assert.equal(result['verbose'], true);
    });

    it('handles --flag at end of args (boolean)', () => {
        const result = parseArgs(['pos1', '--remove-files']);
        assert.deepEqual(result._, ['pos1']);
        assert.equal(result['remove-files'], true);
    });

    it('parses -f file shorthand', () => {
        const result = parseArgs(['-f', 'task.md']);
        assert.equal(result.file, 'task.md');
    });

    it('handles mixed positional and flag args', () => {
        const result = parseArgs(['worker-1', '-f', 'task.md', '--keep-alive']);
        assert.deepEqual(result._, ['worker-1']);
        assert.equal(result.file, 'task.md');
        assert.equal(result['keep-alive'], true);
    });

    it('returns empty positional array when no positional args', () => {
        const result = parseArgs(['--flag']);
        assert.deepEqual(result._, []);
    });

    it('handles empty args', () => {
        const result = parseArgs([]);
        assert.deepEqual(result._, []);
    });

    it('treats --flag followed by --another as two booleans', () => {
        const result = parseArgs(['--flag1', '--flag2']);
        assert.equal(result.flag1, true);
        assert.equal(result.flag2, true);
    });

    it('treats --flag followed by -f as boolean flag', () => {
        const result = parseArgs(['--keep-alive', '-f', 'file.md']);
        assert.equal(result['keep-alive'], true);
        assert.equal(result.file, 'file.md');
    });
});

// ─── CLI Command Integration Tests ───────────────────────────────────
// These run cli.js as a subprocess to test actual command routing.

const CLI_PATH = path.join(__dirname, '..', 'cli.js');

function runCli(args, opts = {}) {
    const env = {
        ...process.env,
        HIVE_DIR: opts.hiveDir || '/tmp/hive-test-nonexistent',
        // Unset token to avoid warnings in unrelated tests
        CLAUDE_CODE_OAUTH_TOKEN: opts.token || '',
    };

    try {
        const output = execSync(`node ${CLI_PATH} ${args}`, {
            encoding: 'utf8',
            env,
            timeout: 5000,
        });
        return { output, exitCode: 0 };
    } catch (err) {
        return {
            output: (err.stdout || '') + (err.stderr || ''),
            exitCode: err.status || 1,
        };
    }
}

describe('CLI help command', () => {
    it('shows usage on --help', () => {
        const { output, exitCode } = runCli('--help');
        assert.equal(exitCode, 0);
        assert.includes(output, 'Hive');
        assert.includes(output, 'Commands:');
        assert.includes(output, 'spawn');
        assert.includes(output, 'list');
        assert.includes(output, 'kill');
    });

    it('shows usage on "help" command', () => {
        const { output, exitCode } = runCli('help');
        assert.equal(exitCode, 0);
        assert.includes(output, 'Usage:');
    });

    it('shows usage when no command given', () => {
        const { output, exitCode } = runCli('');
        assert.equal(exitCode, 0);
        assert.includes(output, 'Usage:');
    });
});

describe('CLI unknown command', () => {
    it('errors on unknown command', () => {
        const { output, exitCode } = runCli('foobar');
        assert.equal(exitCode, 1);
        assert.includes(output, 'Unknown command');
    });
});

describe('CLI spawn validation', () => {
    it('errors when name is missing', () => {
        const { output, exitCode } = runCli('spawn');
        assert.equal(exitCode, 1);
        assert.includes(output, 'Name required');
    });

    it('errors when task is missing', () => {
        const { output, exitCode } = runCli('spawn test-name');
        assert.equal(exitCode, 1);
        assert.includes(output, 'Task required');
    });
});

describe('CLI status validation', () => {
    it('errors when name is missing', () => {
        const { output, exitCode } = runCli('status');
        assert.equal(exitCode, 1);
        assert.includes(output, 'Name required');
    });
});

describe('CLI collect validation', () => {
    it('errors when name is missing', () => {
        const { output, exitCode } = runCli('collect');
        assert.equal(exitCode, 1);
        assert.includes(output, 'Name required');
    });
});

describe('CLI kill validation', () => {
    it('errors when name is missing', () => {
        const { output, exitCode } = runCli('kill');
        assert.equal(exitCode, 1);
        assert.includes(output, 'Name required');
    });
});

describe('CLI list command', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('shows "No minions active" when hive dir is empty', () => {
        tmp = tmpDir();
        const { output, exitCode } = runCli('list', { hiveDir: tmp.dir });
        assert.equal(exitCode, 0);
        assert.includes(output, 'No minions');
    });
});

describe('CLI cleanup command', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('shows "Nothing to clean up" when no minions exist', () => {
        tmp = tmpDir();
        const { output, exitCode } = runCli('cleanup', { hiveDir: tmp.dir });
        assert.equal(exitCode, 0);
        assert.includes(output, 'Nothing to clean up');
    });
});

describe('CLI spawn with -f flag', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('reads task from file with -f', () => {
        tmp = tmpDir();
        const taskFile = path.join(tmp.dir, 'task.md');
        fs.writeFileSync(taskFile, 'Build a CLI tool');

        // This will fail at docker level but we can verify the file reading works
        // by checking it gets past the "Task required" validation
        const { output, exitCode } = runCli(`spawn test-worker -f ${taskFile}`, {
            hiveDir: tmp.dir,
        });
        // Should not fail with "Task required" since we provided -f
        assert.ok(!output.includes('Task required'));
    });
});

describe('CLI watch validation', () => {
    it('errors when name is missing', () => {
        const { output, exitCode } = runCli('watch');
        assert.equal(exitCode, 1);
        assert.includes(output, 'Name required');
    });

    it('errors when minion does not exist', () => {
        tmp = tmpDir();
        const { output, exitCode } = runCli('watch nonexistent', { hiveDir: tmp.dir });
        assert.equal(exitCode, 1);
        assert.includes(output, 'not found');
    });
});

describe('CLI help includes watch', () => {
    it('shows watch command in help', () => {
        const { output, exitCode } = runCli('--help');
        assert.equal(exitCode, 0);
        assert.includes(output, 'watch');
    });
});

describe('CLI logs validation', () => {
    it('errors when name is missing', () => {
        const { output, exitCode } = runCli('logs');
        assert.equal(exitCode, 1);
        assert.includes(output, 'Name required');
    });

    it('errors when minion does not exist', () => {
        tmp = tmpDir();
        const { output, exitCode } = runCli('logs nonexistent', { hiveDir: tmp.dir });
        assert.equal(exitCode, 1);
        assert.includes(output, 'not found');
    });
});

describe('CLI help includes logs', () => {
    it('shows logs command in help', () => {
        const { output, exitCode } = runCli('--help');
        assert.equal(exitCode, 0);
        assert.includes(output, 'logs');
    });
});
