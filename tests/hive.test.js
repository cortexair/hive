/**
 * Tests for Hive class (index.js) - core orchestration logic.
 */

const fs = require('fs');
const path = require('path');
const { describe, it, beforeEach, afterEach, assert } = require('./runner');
const { tmpDir, createMockHive, writeMinionFixture, captureConsole } = require('./helpers');

let tmp;
let hive;

// ─── Constructor & Initialization ────────────────────────────────────

describe('Hive constructor', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('creates hiveDir and minionsDir on construction', () => {
        tmp = tmpDir();
        const hiveDir = path.join(tmp.dir, 'hive-data');
        hive = createMockHive(hiveDir);

        assert.ok(fs.existsSync(hiveDir));
        assert.ok(fs.existsSync(path.join(hiveDir, 'minions')));
    });

    it('uses provided hiveDir', () => {
        tmp = tmpDir();
        const hiveDir = path.join(tmp.dir, 'custom-dir');
        hive = createMockHive(hiveDir);

        assert.equal(hive.hiveDir, hiveDir);
        assert.equal(hive.minionsDir, path.join(hiveDir, 'minions'));
    });

    it('uses HIVE_DIR env var default when none provided', () => {
        const { Hive, HIVE_DIR } = require('../index.js');
        const expectedDefault = path.join(process.env.HOME, '.hive');
        assert.equal(HIVE_DIR, expectedDefault);
    });

    it('is idempotent when dirs already exist', () => {
        tmp = tmpDir();
        const hiveDir = path.join(tmp.dir, 'hive-data');
        fs.mkdirSync(hiveDir, { recursive: true });
        fs.mkdirSync(path.join(hiveDir, 'minions'), { recursive: true });

        assert.doesNotThrow(() => createMockHive(hiveDir));
    });
});

// ─── Docker Command Construction ─────────────────────────────────────

describe('Hive._docker command construction', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('prepends sudo by default', () => {
        const { Hive } = require('../index.js');
        tmp = tmpDir();
        const h = new Hive({ hiveDir: tmp.dir, useSudo: true });
        // We can't easily test the actual command without mocking execSync,
        // but we verify the flag is set
        assert.equal(h.useSudo, true);
    });

    it('skips sudo when useSudo is false', () => {
        const { Hive } = require('../index.js');
        tmp = tmpDir();
        const h = new Hive({ hiveDir: tmp.dir, useSudo: false });
        assert.equal(h.useSudo, false);
    });
});

describe('Hive._dockerAsync args construction', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('constructs correct args with useSudo=false', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        hive._dockerAsync(['run', '-d', 'test-image']);
        assert.deepEqual(hive._dockerAsyncCalls[0], ['run', '-d', 'test-image']);
    });
});

// ─── Image Operations ────────────────────────────────────────────────

describe('Hive.imageExists', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('returns true when docker image inspect succeeds', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.ok(hive.imageExists());
    });

    it('returns false when docker image inspect fails', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.includes('image inspect')) throw new Error('not found');
                return '';
            }
        });
        assert.notOk(hive.imageExists());
    });
});

describe('Hive.buildImage', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('calls docker build with correct image name and path', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        const { logs } = captureConsole(() => hive.buildImage('/some/path'));

        const buildCall = hive._dockerCalls.find(c => c.startsWith('build'));
        assert.ok(buildCall);
        assert.includes(buildCall, 'cortex/hive-minion');
        assert.includes(buildCall, '/some/path');
    });

    it('returns true on success', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        const { result } = captureConsole(() => hive.buildImage('/path'));
        assert.equal(result, true);
    });
});

// ─── Spawn ───────────────────────────────────────────────────────────

describe('Hive.spawn', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('creates workspace directory structure', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        const { logs } = captureConsole(() => hive.spawn('test-minion', 'Do the thing'));

        const minionDir = path.join(tmp.dir, 'minions', 'test-minion');
        assert.ok(fs.existsSync(minionDir));
        assert.ok(fs.existsSync(path.join(minionDir, 'output')));
    });

    it('writes TASK.md with full task content', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        captureConsole(() => hive.spawn('writer', 'Build a REST API'));

        const taskContent = fs.readFileSync(
            path.join(tmp.dir, 'minions', 'writer', 'TASK.md'), 'utf8'
        );
        assert.equal(taskContent, 'Build a REST API');
    });

    it('writes meta.json with correct initial fields', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        captureConsole(() => hive.spawn('meta-test', 'Some task'));

        const meta = JSON.parse(fs.readFileSync(
            path.join(tmp.dir, 'minions', 'meta-test', 'meta.json'), 'utf8'
        ));
        assert.equal(meta.name, 'meta-test');
        assert.equal(meta.status, 'running'); // updated after container start
        assert.equal(meta.containerId, 'abc123containerid');
        assert.ok(meta.createdAt);
    });

    it('truncates task in meta.json to 200 chars', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        const longTask = 'x'.repeat(500);
        captureConsole(() => hive.spawn('long-task', longTask));

        const meta = JSON.parse(fs.readFileSync(
            path.join(tmp.dir, 'minions', 'long-task', 'meta.json'), 'utf8'
        ));
        assert.equal(meta.task.length, 200);
    });

    it('throws if minion name already exists', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        captureConsole(() => hive.spawn('dupe', 'First task'));

        assert.throws(
            () => hive.spawn('dupe', 'Second task'),
            'already exists'
        );
    });

    it('returns name, containerId, and minionDir', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        let result;
        captureConsole(() => { result = hive.spawn('ret-test', 'A task'); });

        assert.equal(result.name, 'ret-test');
        assert.equal(result.containerId, 'abc123containerid');
        assert.equal(result.minionDir, path.join(tmp.dir, 'minions', 'ret-test'));
    });

    it('passes CLAUDE_CODE_OAUTH_TOKEN env var when provided', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        captureConsole(() => hive.spawn('env-test', 'Task', { claudeToken: 'tok123' }));

        const runCall = hive._dockerCalls.find(c => c.startsWith('run'));
        assert.ok(runCall);
        assert.includes(runCall, 'CLAUDE_CODE_OAUTH_TOKEN=tok123');
    });

    it('passes KEEP_ALIVE env var when keepAlive option is set', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        captureConsole(() => hive.spawn('alive-test', 'Task', { keepAlive: true }));

        const runCall = hive._dockerCalls.find(c => c.startsWith('run'));
        assert.includes(runCall, 'KEEP_ALIVE=true');
    });

    it('does not include env vars when options are absent', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        captureConsole(() => hive.spawn('no-env', 'Task'));

        const runCall = hive._dockerCalls.find(c => c.startsWith('run'));
        assert.ok(!runCall.includes('CLAUDE_CODE_OAUTH_TOKEN'));
        assert.ok(!runCall.includes('KEEP_ALIVE'));
    });

    it('auto-builds image when it does not exist', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.includes('image inspect')) throw new Error('not found');
                if (cmd.startsWith('build')) return 'built\n';
                if (cmd.startsWith('run')) return 'container123\n';
                return '';
            }
        });
        captureConsole(() => hive.spawn('auto-build', 'Task'));

        const buildCalls = hive._dockerCalls.filter(c => c.startsWith('build'));
        assert.equal(buildCalls.length, 1);
    });

    it('mounts minion workspace directory as volume', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        captureConsole(() => hive.spawn('vol-test', 'Task'));

        const runCall = hive._dockerCalls.find(c => c.startsWith('run'));
        const expectedVolume = path.join(tmp.dir, 'minions', 'vol-test');
        assert.includes(runCall, `-v ${expectedVolume}:/home/minion/workspace`);
    });
});

// ─── List ────────────────────────────────────────────────────────────

describe('Hive.list', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('returns empty array when no minions exist', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        const minions = hive.list();
        assert.deepEqual(minions, []);
    });

    it('returns empty array when minions dir is missing', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        fs.rmSync(hive.minionsDir, { recursive: true });
        const minions = hive.list();
        assert.deepEqual(minions, []);
    });

    it('lists minions with metadata', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'worker-1', {
            task: 'Build something',
            status: 'running',
            containerId: 'sha256:abc'
        });

        const minions = hive.list();
        assert.equal(minions.length, 1);
        assert.equal(minions[0].name, 'worker-1');
        assert.equal(minions[0].task, 'Build something');
    });

    it('includes container status from docker inspect', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.includes('inspect -f')) return "'exited'\n";
                return '';
            }
        });
        writeMinionFixture(hive.minionsDir, 'worker-2', { containerId: 'sha256:def' });

        const minions = hive.list();
        assert.equal(minions[0].containerStatus, "'exited'");
    });

    it('marks container as removed when inspect fails', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.includes('inspect -f')) throw new Error('not found');
                return '';
            }
        });
        writeMinionFixture(hive.minionsDir, 'gone', { containerId: 'sha256:gone' });

        const minions = hive.list();
        assert.equal(minions[0].containerStatus, 'removed');
    });

    it('includes taskStatus from STATUS file', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'done', { taskStatus: 'COMPLETE' });

        const minions = hive.list();
        assert.equal(minions[0].taskStatus, 'COMPLETE');
    });

    it('lists multiple minions', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'a', { taskStatus: 'COMPLETE' });
        writeMinionFixture(hive.minionsDir, 'b', { taskStatus: 'WORKING' });
        writeMinionFixture(hive.minionsDir, 'c', { taskStatus: 'FAILED' });

        const minions = hive.list();
        assert.equal(minions.length, 3);
    });

    it('skips directories without meta.json', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        fs.mkdirSync(path.join(hive.minionsDir, 'no-meta'), { recursive: true });
        writeMinionFixture(hive.minionsDir, 'has-meta', {});

        const minions = hive.list();
        assert.equal(minions.length, 1);
        assert.equal(minions[0].name, 'has-meta');
    });
});

// ─── Status ──────────────────────────────────────────────────────────

describe('Hive.status', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('throws when minion does not exist', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.throws(() => hive.status('ghost'), 'not found');
    });

    it('returns metadata from meta.json', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 's1', {
            task: 'Do work',
            status: 'running',
            containerId: 'sha256:s1id'
        });

        const status = hive.status('s1');
        assert.equal(status.name, 's1');
        assert.equal(status.task, 'Do work');
        assert.equal(status.status, 'running');
    });

    it('includes taskStatus from STATUS file', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 's2', { taskStatus: 'WORKING' });

        const status = hive.status('s2');
        assert.equal(status.taskStatus, 'WORKING');
    });

    it('includes output from claude-output.log', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 's3', { output: 'Here is the answer.' });

        const status = hive.status('s3');
        assert.equal(status.output, 'Here is the answer.');
    });

    it('includes container logs', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.startsWith('logs')) return 'container log output\n';
                return '';
            }
        });
        writeMinionFixture(hive.minionsDir, 's4', { containerId: 'sha256:s4id' });

        const status = hive.status('s4');
        assert.equal(status.logs, 'container log output\n');
    });

    it('returns "(container removed)" when logs fail', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.startsWith('logs')) throw new Error('no such container');
                return '';
            }
        });
        writeMinionFixture(hive.minionsDir, 's5', { containerId: 'sha256:s5id' });

        const status = hive.status('s5');
        assert.equal(status.logs, '(container removed)');
    });

    it('omits output field when no output file exists', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 's6', {}); // no output

        const status = hive.status('s6');
        assert.equal(status.output, undefined);
    });
});

// ─── Logs ────────────────────────────────────────────────────────────

describe('Hive.logs', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('throws when minion does not exist', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.throws(() => hive.logs('ghost'), 'not found');
    });

    it('throws when minion has no container', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        // Write fixture manually without containerId
        const minionDir = path.join(hive.minionsDir, 'no-container');
        fs.mkdirSync(minionDir, { recursive: true });
        fs.writeFileSync(path.join(minionDir, 'meta.json'), JSON.stringify({
            name: 'no-container',
            createdAt: '2026-01-01T00:00:00.000Z',
            task: 'Test task',
            status: 'pending',
            containerId: null
        }, null, 2));

        assert.throws(() => hive.logs('no-container'), 'no container');
    });

    it('returns docker logs output', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.includes('logs --tail')) return 'line 1\nline 2\nline 3\n';
                return '';
            }
        });
        writeMinionFixture(hive.minionsDir, 'log-test', { containerId: 'sha256:logid' });

        const logs = hive.logs('log-test');
        assert.equal(logs, 'line 1\nline 2\nline 3\n');
    });

    it('uses default lines count of 50', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'default-lines', { containerId: 'sha256:def' });

        hive.logs('default-lines');
        const logsCall = hive._dockerCalls.find(c => c.includes('logs --tail'));
        assert.includes(logsCall, '--tail 50');
    });

    it('uses custom lines count when provided', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'custom-lines', { containerId: 'sha256:cust' });

        hive.logs('custom-lines', 100);
        const logsCall = hive._dockerCalls.find(c => c.includes('logs --tail'));
        assert.includes(logsCall, '--tail 100');
    });

    it('throws when container is removed', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.includes('logs')) throw new Error('no such container');
                return '';
            }
        });
        writeMinionFixture(hive.minionsDir, 'removed', { containerId: 'sha256:gone' });

        assert.throws(() => hive.logs('removed'), 'container may be removed');
    });
});

// ─── Collect ─────────────────────────────────────────────────────────

describe('Hive.collect', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('returns name, taskStatus, output, and logs', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.startsWith('logs')) return 'log data';
                return '';
            }
        });
        writeMinionFixture(hive.minionsDir, 'c1', {
            taskStatus: 'COMPLETE',
            output: 'Result data',
            containerId: 'sha256:c1'
        });

        const result = hive.collect('c1');
        assert.equal(result.name, 'c1');
        assert.equal(result.taskStatus, 'COMPLETE');
        assert.equal(result.output, 'Result data');
        assert.equal(result.logs, 'log data');
    });

    it('throws when minion does not exist', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.throws(() => hive.collect('nope'), 'not found');
    });
});

// ─── Kill ────────────────────────────────────────────────────────────

describe('Hive.kill', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('throws when minion does not exist', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.throws(() => hive.kill('phantom'), 'not found');
    });

    it('calls docker stop and docker rm', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'k1', { containerId: 'sha256:k1' });

        hive.kill('k1');
        const stopCall = hive._dockerCalls.find(c => c.startsWith('stop'));
        const rmCall = hive._dockerCalls.find(c => c.startsWith('rm'));
        assert.ok(stopCall);
        assert.ok(rmCall);
        assert.includes(stopCall, 'hive-k1');
        assert.includes(rmCall, 'hive-k1');
    });

    it('updates meta.json with killed status and timestamp', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'k2', { containerId: 'sha256:k2' });

        hive.kill('k2');
        const meta = JSON.parse(fs.readFileSync(
            path.join(hive.minionsDir, 'k2', 'meta.json'), 'utf8'
        ));
        assert.equal(meta.status, 'killed');
        assert.ok(meta.killedAt);
    });

    it('returns name and killed status', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'k3', { containerId: 'sha256:k3' });

        const result = hive.kill('k3');
        assert.equal(result.name, 'k3');
        assert.equal(result.status, 'killed');
    });

    it('does not throw if docker stop/rm fails (container already gone)', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.startsWith('stop') || cmd.startsWith('rm')) {
                    throw new Error('no such container');
                }
                return '';
            }
        });
        writeMinionFixture(hive.minionsDir, 'k4', { containerId: 'sha256:k4' });

        assert.doesNotThrow(() => hive.kill('k4'));
    });
});

// ─── Cleanup ─────────────────────────────────────────────────────────

describe('Hive.cleanup', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('removes containers for COMPLETE minions', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'done1', {
            taskStatus: 'COMPLETE',
            containerId: 'sha256:done1'
        });

        const cleaned = hive.cleanup();
        assert.includes(cleaned, 'done1');
    });

    it('removes containers for killed minions', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'killed1', {
            status: 'killed',
            containerId: 'sha256:killed1'
        });

        const cleaned = hive.cleanup();
        assert.includes(cleaned, 'killed1');
    });

    it('does not remove running minions', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'active', {
            taskStatus: 'WORKING',
            status: 'running',
            containerId: 'sha256:active'
        });

        const cleaned = hive.cleanup();
        assert.equal(cleaned.length, 0);
    });

    it('deletes workspace files when removeFiles is true', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'rm1', {
            taskStatus: 'COMPLETE',
            containerId: 'sha256:rm1'
        });

        hive.cleanup({ removeFiles: true });
        assert.notOk(fs.existsSync(path.join(hive.minionsDir, 'rm1')));
    });

    it('preserves workspace files by default', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'keep1', {
            taskStatus: 'COMPLETE',
            containerId: 'sha256:keep1'
        });

        hive.cleanup();
        assert.ok(fs.existsSync(path.join(hive.minionsDir, 'keep1')));
    });

    it('returns array of cleaned minion names', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'c1', { taskStatus: 'COMPLETE', containerId: 'sha256:c1' });
        writeMinionFixture(hive.minionsDir, 'c2', { status: 'killed', containerId: 'sha256:c2' });
        writeMinionFixture(hive.minionsDir, 'c3', { taskStatus: 'WORKING', status: 'running', containerId: 'sha256:c3' });

        const cleaned = hive.cleanup();
        assert.equal(cleaned.length, 2);
        assert.includes(cleaned, 'c1');
        assert.includes(cleaned, 'c2');
    });

    it('handles docker rm failure gracefully', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.startsWith('rm')) throw new Error('already removed');
                if (cmd.includes('inspect -f')) return "'exited'\n";
                return '';
            }
        });
        writeMinionFixture(hive.minionsDir, 'err1', { taskStatus: 'COMPLETE', containerId: 'sha256:err1' });

        assert.doesNotThrow(() => hive.cleanup());
    });
});

// ─── Restart ─────────────────────────────────────────────────────────

describe('Hive.restart', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('throws when minion does not exist', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.throws(() => hive.restart('ghost'), 'not found');
    });

    it('throws when minion has no container', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        const minionDir = path.join(hive.minionsDir, 'no-container');
        fs.mkdirSync(minionDir, { recursive: true });
        fs.writeFileSync(path.join(minionDir, 'meta.json'), JSON.stringify({
            name: 'no-container',
            containerId: null
        }, null, 2));

        assert.throws(() => hive.restart('no-container'), 'no container');
    });

    it('calls docker restart', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'r1', { containerId: 'sha256:r1' });

        hive.restart('r1');
        const restartCall = hive._dockerCalls.find(c => c.startsWith('restart'));
        assert.ok(restartCall);
        assert.includes(restartCall, 'hive-r1');
    });

    it('updates meta.json with running status and restartedAt', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'r2', { containerId: 'sha256:r2' });

        hive.restart('r2');
        const meta = JSON.parse(fs.readFileSync(
            path.join(hive.minionsDir, 'r2', 'meta.json'), 'utf8'
        ));
        assert.equal(meta.status, 'running');
        assert.ok(meta.restartedAt);
    });

    it('returns name and restarted status', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'r3', { containerId: 'sha256:r3' });

        const result = hive.restart('r3');
        assert.equal(result.name, 'r3');
        assert.equal(result.status, 'restarted');
    });
});

// ─── Pause ───────────────────────────────────────────────────────────

describe('Hive.pause', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('throws when minion does not exist', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.throws(() => hive.pause('ghost'), 'not found');
    });

    it('throws when minion has no container', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        const minionDir = path.join(hive.minionsDir, 'no-container');
        fs.mkdirSync(minionDir, { recursive: true });
        fs.writeFileSync(path.join(minionDir, 'meta.json'), JSON.stringify({
            name: 'no-container',
            containerId: null
        }, null, 2));

        assert.throws(() => hive.pause('no-container'), 'no container');
    });

    it('calls docker pause', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'p1', { containerId: 'sha256:p1' });

        hive.pause('p1');
        const pauseCall = hive._dockerCalls.find(c => c.startsWith('pause'));
        assert.ok(pauseCall);
        assert.includes(pauseCall, 'hive-p1');
    });

    it('updates meta.json with paused status and pausedAt', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'p2', { containerId: 'sha256:p2' });

        hive.pause('p2');
        const meta = JSON.parse(fs.readFileSync(
            path.join(hive.minionsDir, 'p2', 'meta.json'), 'utf8'
        ));
        assert.equal(meta.status, 'paused');
        assert.ok(meta.pausedAt);
    });

    it('returns name and paused status', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'p3', { containerId: 'sha256:p3' });

        const result = hive.pause('p3');
        assert.equal(result.name, 'p3');
        assert.equal(result.status, 'paused');
    });
});

// ─── Resume ──────────────────────────────────────────────────────────

describe('Hive.resume', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('throws when minion does not exist', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.throws(() => hive.resume('ghost'), 'not found');
    });

    it('throws when minion has no container', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        const minionDir = path.join(hive.minionsDir, 'no-container');
        fs.mkdirSync(minionDir, { recursive: true });
        fs.writeFileSync(path.join(minionDir, 'meta.json'), JSON.stringify({
            name: 'no-container',
            containerId: null
        }, null, 2));

        assert.throws(() => hive.resume('no-container'), 'no container');
    });

    it('calls docker unpause', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'u1', { containerId: 'sha256:u1' });

        hive.resume('u1');
        const unpauseCall = hive._dockerCalls.find(c => c.startsWith('unpause'));
        assert.ok(unpauseCall);
        assert.includes(unpauseCall, 'hive-u1');
    });

    it('updates meta.json with running status and resumedAt', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'u2', { containerId: 'sha256:u2' });

        hive.resume('u2');
        const meta = JSON.parse(fs.readFileSync(
            path.join(hive.minionsDir, 'u2', 'meta.json'), 'utf8'
        ));
        assert.equal(meta.status, 'running');
        assert.ok(meta.resumedAt);
    });

    it('returns name and running status', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'u3', { containerId: 'sha256:u3' });

        const result = hive.resume('u3');
        assert.equal(result.name, 'u3');
        assert.equal(result.status, 'running');
    });
});

// ─── Stats ───────────────────────────────────────────────────────────

describe('Hive.stats', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('throws when minion does not exist', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.throws(() => hive.stats('ghost'), 'not found');
    });

    it('throws when minion has no container', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        const minionDir = path.join(hive.minionsDir, 'no-container');
        fs.mkdirSync(minionDir, { recursive: true });
        fs.writeFileSync(path.join(minionDir, 'meta.json'), JSON.stringify({
            name: 'no-container',
            containerId: null
        }, null, 2));

        assert.throws(() => hive.stats('no-container'), 'no container');
    });

    it('returns parsed JSON stats from docker', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.includes('stats')) {
                    return JSON.stringify({
                        CPUPerc: '0.50%',
                        MemUsage: '50MiB / 1GiB',
                        MemPerc: '5.00%',
                        NetIO: '1kB / 2kB',
                        BlockIO: '0B / 0B',
                        PIDs: '5'
                    });
                }
                return '';
            }
        });
        writeMinionFixture(hive.minionsDir, 'st1', { containerId: 'sha256:st1' });

        const stats = hive.stats('st1');
        assert.equal(stats.CPUPerc, '0.50%');
        assert.equal(stats.MemPerc, '5.00%');
        assert.equal(stats.PIDs, '5');
    });

    it('throws when container is not running', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.includes('stats')) throw new Error('container not running');
                return '';
            }
        });
        writeMinionFixture(hive.minionsDir, 'st2', { containerId: 'sha256:st2' });

        assert.throws(() => hive.stats('st2'), 'container may not be running');
    });
});

// ─── Module Exports ──────────────────────────────────────────────────

describe('Module exports', () => {
    it('exports Hive class', () => {
        const mod = require('../index.js');
        assert.equal(typeof mod.Hive, 'function');
    });

    it('exports HIVE_DIR constant', () => {
        const mod = require('../index.js');
        assert.equal(typeof mod.HIVE_DIR, 'string');
    });

    it('exports IMAGE_NAME constant', () => {
        const mod = require('../index.js');
        assert.equal(mod.IMAGE_NAME, 'cortex/hive-minion');
    });
});
