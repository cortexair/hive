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

// ─── Name Validation ─────────────────────────────────────────────────

describe('Hive._validateName', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('accepts valid alphanumeric names', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.doesNotThrow(() => hive._validateName('my-minion'));
        assert.doesNotThrow(() => hive._validateName('worker_01'));
        assert.doesNotThrow(() => hive._validateName('test.v2'));
        assert.doesNotThrow(() => hive._validateName('A'));
        assert.doesNotThrow(() => hive._validateName('3workers'));
    });

    it('rejects empty or missing name', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.throws(() => hive._validateName(''), 'name is required');
        assert.throws(() => hive._validateName(null), 'name is required');
        assert.throws(() => hive._validateName(undefined), 'name is required');
    });

    it('rejects names with spaces', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.throws(() => hive._validateName('my minion'), 'Invalid minion name');
    });

    it('rejects names with special characters', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.throws(() => hive._validateName('minion@home'), 'Invalid minion name');
        assert.throws(() => hive._validateName('worker/1'), 'Invalid minion name');
        assert.throws(() => hive._validateName('test$var'), 'Invalid minion name');
    });

    it('rejects names starting with dot or dash', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.throws(() => hive._validateName('.hidden'), 'Invalid minion name');
        assert.throws(() => hive._validateName('-flag'), 'Invalid minion name');
    });

    it('rejects names longer than 128 characters', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.throws(() => hive._validateName('a'.repeat(129)), 'too long');
    });

    it('accepts names at exactly 128 characters', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.doesNotThrow(() => hive._validateName('a'.repeat(128)));
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

    it('throws on invalid minion name', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.throws(() => hive.spawn('bad name', 'task'), 'Invalid minion name');
        assert.throws(() => hive.spawn('', 'task'), 'name is required');
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

    it('passes --memory flag when memory option is set', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        captureConsole(() => hive.spawn('mem-test', 'Task', { memory: '512m' }));

        const runCall = hive._dockerCalls.find(c => c.startsWith('run'));
        assert.includes(runCall, '--memory=512m');
    });

    it('passes --cpus flag when cpus option is set', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        captureConsole(() => hive.spawn('cpu-test', 'Task', { cpus: '1.5' }));

        const runCall = hive._dockerCalls.find(c => c.startsWith('run'));
        assert.includes(runCall, '--cpus=1.5');
    });

    it('passes both resource limits when both options are set', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        captureConsole(() => hive.spawn('resource-test', 'Task', { memory: '1g', cpus: '2' }));

        const runCall = hive._dockerCalls.find(c => c.startsWith('run'));
        assert.includes(runCall, '--memory=1g');
        assert.includes(runCall, '--cpus=2');
    });

    it('stores resource limits in metadata', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        captureConsole(() => hive.spawn('meta-resource', 'Task', { memory: '2g', cpus: '0.5' }));

        const meta = JSON.parse(fs.readFileSync(path.join(tmp.dir, 'minions', 'meta-resource', 'meta.json'), 'utf8'));
        assert.equal(meta.memory, '2g');
        assert.equal(meta.cpus, '0.5');
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

// ─── SpawnWaiting ────────────────────────────────────────────────

describe('Hive.spawnWaiting', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('creates workspace with waiting status', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        // Create dependency minion first
        writeMinionFixture(hive.minionsDir, 'step-1', { taskContent: 'First task' });

        const result = hive.spawnWaiting('step-2', 'Second task', 'step-1');
        assert.equal(result.status, 'waiting');
        assert.equal(result.dependsOn, 'step-1');

        const minionDir = path.join(tmp.dir, 'minions', 'step-2');
        assert.ok(fs.existsSync(minionDir));
        assert.ok(fs.existsSync(path.join(minionDir, 'output')));
    });

    it('writes TASK.md with full task content', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'dep', { taskContent: 'Dep task' });

        hive.spawnWaiting('waiter', 'My waiting task', 'dep');
        const task = fs.readFileSync(path.join(tmp.dir, 'minions', 'waiter', 'TASK.md'), 'utf8');
        assert.equal(task, 'My waiting task');
    });

    it('writes meta.json with waiting status and dependsOn', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'dep', { taskContent: 'Dep task' });

        hive.spawnWaiting('waiter', 'Task text', 'dep');
        const meta = JSON.parse(fs.readFileSync(
            path.join(tmp.dir, 'minions', 'waiter', 'meta.json'), 'utf8'
        ));
        assert.equal(meta.name, 'waiter');
        assert.equal(meta.status, 'waiting');
        assert.equal(meta.dependsOn, 'dep');
        assert.equal(meta.containerId, null);
        assert.ok(meta.createdAt);
    });

    it('does not start a container', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'dep', { taskContent: 'Dep task' });

        hive.spawnWaiting('waiter', 'Task', 'dep');
        const runCalls = hive._dockerCalls.filter(c => c.startsWith('run'));
        assert.equal(runCalls.length, 0);
    });

    it('throws when dependency minion does not exist', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.throws(
            () => hive.spawnWaiting('waiter', 'Task', 'nonexistent'),
            "Dependency minion 'nonexistent' not found"
        );
    });

    it('throws when minion name already exists', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'dep', { taskContent: 'Dep task' });
        writeMinionFixture(hive.minionsDir, 'dupe', { taskContent: 'Existing' });

        assert.throws(
            () => hive.spawnWaiting('dupe', 'Task', 'dep'),
            'already exists'
        );
    });

    it('throws on invalid minion name', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'dep', { taskContent: 'Dep task' });
        assert.throws(() => hive.spawnWaiting('bad name', 'Task', 'dep'), 'Invalid minion name');
    });

    it('stores resource limits in metadata', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'dep', { taskContent: 'Dep task' });

        hive.spawnWaiting('waiter', 'Task', 'dep', { memory: '1g', cpus: '2' });
        const meta = JSON.parse(fs.readFileSync(
            path.join(tmp.dir, 'minions', 'waiter', 'meta.json'), 'utf8'
        ));
        assert.equal(meta.memory, '1g');
        assert.equal(meta.cpus, '2');
    });
});

// ─── Start ───────────────────────────────────────────────────────

describe('Hive.start', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('starts a waiting minion and creates container', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'dep', { taskContent: 'Dep task' });
        hive.spawnWaiting('waiter', 'My task', 'dep');

        const result = hive.start('waiter', { claudeToken: 'tok' });
        assert.equal(result.name, 'waiter');
        assert.equal(result.containerId, 'abc123containerid');
    });

    it('starts a pending minion (from clone)', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'pending-m', {
            status: 'pending',
            taskContent: 'A task',
            containerId: null,
            extraMeta: { containerId: null }
        });
        // Overwrite meta to ensure pending status with no containerId
        fs.writeFileSync(path.join(hive.minionsDir, 'pending-m', 'meta.json'), JSON.stringify({
            name: 'pending-m',
            createdAt: '2026-01-01T00:00:00.000Z',
            task: 'A task',
            status: 'pending',
            containerId: null
        }));

        const result = hive.start('pending-m', { claudeToken: 'tok' });
        assert.equal(result.name, 'pending-m');
        assert.ok(result.containerId);
    });

    it('updates meta.json to running with startedAt', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'dep', { taskContent: 'Dep' });
        hive.spawnWaiting('w', 'Task', 'dep');

        hive.start('w');
        const meta = JSON.parse(fs.readFileSync(
            path.join(tmp.dir, 'minions', 'w', 'meta.json'), 'utf8'
        ));
        assert.equal(meta.status, 'running');
        assert.ok(meta.startedAt);
        assert.equal(meta.containerId, 'abc123containerid');
    });

    it('throws when minion does not exist', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.throws(() => hive.start('ghost'), 'not found');
    });

    it('throws when minion is already running', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'running-m', {
            status: 'running',
            containerId: 'sha256:abc'
        });

        assert.throws(() => hive.start('running-m'), 'not pending/waiting');
    });

    it('throws when minion has no TASK.md', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        const minionDir = path.join(hive.minionsDir, 'no-task');
        fs.mkdirSync(minionDir, { recursive: true });
        fs.writeFileSync(path.join(minionDir, 'meta.json'), JSON.stringify({
            name: 'no-task', status: 'waiting', containerId: null
        }));

        assert.throws(() => hive.start('no-task'), 'no TASK.md');
    });

    it('carries forward resource limits from meta', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'dep', { taskContent: 'Dep' });
        hive.spawnWaiting('res', 'Task', 'dep', { memory: '512m', cpus: '1' });

        hive.start('res');
        const runCall = hive._dockerCalls.find(c => c.startsWith('run'));
        assert.includes(runCall, '--memory=512m');
        assert.includes(runCall, '--cpus=1');
    });

    it('allows overriding resource limits on start', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'dep', { taskContent: 'Dep' });
        hive.spawnWaiting('ovr', 'Task', 'dep', { memory: '512m' });

        hive.start('ovr', { memory: '2g' });
        const runCall = hive._dockerCalls.find(c => c.startsWith('run'));
        assert.includes(runCall, '--memory=2g');
    });

    it('passes claudeToken env var', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'dep', { taskContent: 'Dep' });
        hive.spawnWaiting('tok', 'Task', 'dep');

        hive.start('tok', { claudeToken: 'mytoken' });
        const runCall = hive._dockerCalls.find(c => c.startsWith('run'));
        assert.includes(runCall, 'CLAUDE_CODE_OAUTH_TOKEN=mytoken');
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

// ─── Wait ────────────────────────────────────────────────────────────

describe('Hive.wait', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('resolves immediately when minion is COMPLETE', async () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'done', {
            taskStatus: 'COMPLETE',
            output: 'Output data',
            containerId: 'sha256:done'
        });

        const result = await hive.wait('done', { pollMs: 10 });
        assert.equal(result.status, 'COMPLETE');
        assert.equal(result.output, 'Output data');
    });

    it('resolves immediately when minion is FAILED', async () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'fail', {
            taskStatus: 'FAILED',
            output: 'Error data',
            containerId: 'sha256:fail'
        });

        const result = await hive.wait('fail', { pollMs: 10 });
        assert.equal(result.status, 'FAILED');
        assert.equal(result.output, 'Error data');
    });

    it('times out when minion stays WORKING', async () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'slow', {
            taskStatus: 'WORKING',
            containerId: 'sha256:slow'
        });

        const result = await hive.wait('slow', { timeoutMs: 50, pollMs: 10 });
        assert.equal(result.status, 'TIMEOUT');
    });

    it('polls until status changes to COMPLETE', async () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'eventual', {
            taskStatus: 'WORKING',
            containerId: 'sha256:eventual'
        });

        // Simulate status change after a short delay
        setTimeout(() => {
            const statusPath = path.join(hive.minionsDir, 'eventual', 'STATUS');
            fs.writeFileSync(statusPath, 'COMPLETE');
        }, 30);

        const result = await hive.wait('eventual', { timeoutMs: 500, pollMs: 10 });
        assert.equal(result.status, 'COMPLETE');
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

// ─── Templates ──────────────────────────────────────────────────────

describe('Hive.templateSave', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('saves template to templates directory', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        hive.templateSave('my-task', '# Do the thing\nBuild a CLI tool');

        const filePath = path.join(tmp.dir, 'templates', 'my-task.md');
        assert.ok(fs.existsSync(filePath));
        assert.equal(fs.readFileSync(filePath, 'utf8'), '# Do the thing\nBuild a CLI tool');
    });

    it('returns name and path', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        const result = hive.templateSave('test-tpl', 'content');

        assert.equal(result.name, 'test-tpl');
        assert.equal(result.path, path.join(tmp.dir, 'templates', 'test-tpl.md'));
    });

    it('overwrites existing template', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        hive.templateSave('overwrite', 'version 1');
        hive.templateSave('overwrite', 'version 2');

        const content = fs.readFileSync(path.join(tmp.dir, 'templates', 'overwrite.md'), 'utf8');
        assert.equal(content, 'version 2');
    });
});

describe('Hive.templateList', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('returns empty array when no templates exist', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        const templates = hive.templateList();
        assert.deepEqual(templates, []);
    });

    it('lists saved templates with metadata', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        hive.templateSave('code-review', 'Review the code for bugs');

        const templates = hive.templateList();
        assert.equal(templates.length, 1);
        assert.equal(templates[0].name, 'code-review');
        assert.ok(templates[0].size > 0);
        assert.ok(templates[0].modifiedAt);
        assert.includes(templates[0].preview, 'Review the code');
    });

    it('lists multiple templates', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        hive.templateSave('tpl-a', 'Task A');
        hive.templateSave('tpl-b', 'Task B');
        hive.templateSave('tpl-c', 'Task C');

        const templates = hive.templateList();
        assert.equal(templates.length, 3);
    });

    it('only lists .md files', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        hive.templateSave('valid', 'content');
        // Write a non-.md file directly
        fs.writeFileSync(path.join(tmp.dir, 'templates', 'not-a-template.txt'), 'junk');

        const templates = hive.templateList();
        assert.equal(templates.length, 1);
        assert.equal(templates[0].name, 'valid');
    });
});

describe('Hive.templateGet', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('returns template content', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        hive.templateSave('fetch-me', 'The full template content here');

        const content = hive.templateGet('fetch-me');
        assert.equal(content, 'The full template content here');
    });

    it('throws when template does not exist', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.throws(() => hive.templateGet('nonexistent'), 'not found');
    });
});

describe('Hive.templateDelete', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('deletes an existing template', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        hive.templateSave('doomed', 'content');

        hive.templateDelete('doomed');
        assert.notOk(fs.existsSync(path.join(tmp.dir, 'templates', 'doomed.md')));
    });

    it('returns name and deleted status', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        hive.templateSave('del-test', 'content');

        const result = hive.templateDelete('del-test');
        assert.equal(result.name, 'del-test');
        assert.equal(result.deleted, true);
    });

    it('throws when template does not exist', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.throws(() => hive.templateDelete('ghost'), 'not found');
    });
});

// ─── Health ──────────────────────────────────────────────────────────

describe('Hive.health', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('reports docker not running when _docker throws', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.includes('info')) throw new Error('Cannot connect to Docker daemon');
                return '';
            }
        });

        const h = hive.health();
        assert.equal(h.docker.running, false);
        assert.equal(h.image.exists, false);
        assert.equal(h.minions.total, 0);
    });

    it('returns early when docker is not running', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                throw new Error('Cannot connect to Docker daemon');
            }
        });

        const h = hive.health();
        assert.equal(h.docker.running, false);
        // Should not attempt image or disk checks
        assert.equal(h.image.exists, false);
        assert.notOk(h.disk.usage);
    });

    it('reports docker running and image exists with age', () => {
        tmp = tmpDir();
        const imageDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.includes('info')) return '24.0.0\n';
                if (cmd.includes('image inspect')) return JSON.stringify(imageDate.toISOString()) + '\n';
                if (cmd.includes('system df')) return JSON.stringify({ Type: 'Images', TotalCount: '5', Reclaimable: '1.2GB' }) + '\n';
                if (cmd.includes('inspect -f')) return "'running'\n";
                return '';
            }
        });

        const h = hive.health();
        assert.equal(h.docker.running, true);
        assert.equal(h.image.exists, true);
        assert.includes(h.image.age, '2d');
        assert.ok(h.image.created);
    });

    it('reports image not found when image inspect throws', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.includes('info')) return '24.0.0\n';
                if (cmd.includes('image inspect')) throw new Error('No such image');
                if (cmd.includes('system df')) return JSON.stringify({ Type: 'Images', TotalCount: '0', Reclaimable: '0B' }) + '\n';
                return '';
            }
        });

        const h = hive.health();
        assert.equal(h.docker.running, true);
        assert.equal(h.image.exists, false);
        assert.notOk(h.image.age);
    });

    it('counts minions by status', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.includes('info')) return '24.0.0\n';
                if (cmd.includes('image inspect') && cmd.includes('Created')) throw new Error('No such image');
                if (cmd.includes('system df')) return JSON.stringify({ Type: 'Images', TotalCount: '0', Reclaimable: '0B' }) + '\n';
                if (cmd.includes('inspect -f')) return "'running'\n";
                return '';
            }
        });
        writeMinionFixture(hive.minionsDir, 'w1', { status: 'running', containerId: 'sha256:w1' });
        writeMinionFixture(hive.minionsDir, 'w2', { status: 'running', containerId: 'sha256:w2' });
        writeMinionFixture(hive.minionsDir, 'w3', { status: 'killed', extraMeta: { containerId: null } });

        const h = hive.health();
        assert.equal(h.minions.total, 3);
        assert.equal(h.minions.running, 2);
        assert.equal(h.minions.byStatus['running'], 2);
    });

    it('reports disk usage from docker system df', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.includes('info')) return '24.0.0\n';
                if (cmd.includes('image inspect')) throw new Error('No such image');
                if (cmd.includes('system df')) {
                    return [
                        JSON.stringify({ Type: 'Images', TotalCount: '5', Reclaimable: '1.2GB' }),
                        JSON.stringify({ Type: 'Containers', TotalCount: '3', Reclaimable: '500MB' })
                    ].join('\n') + '\n';
                }
                return '';
            }
        });

        const h = hive.health();
        assert.ok(h.disk.usage);
        assert.equal(h.disk.usage.length, 2);
        assert.equal(h.disk.usage[0].Type, 'Images');
        assert.equal(h.disk.usage[1].Type, 'Containers');
    });

    it('handles disk info unavailable gracefully', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.includes('info')) return '24.0.0\n';
                if (cmd.includes('image inspect')) throw new Error('No such image');
                if (cmd.includes('system df')) throw new Error('permission denied');
                return '';
            }
        });

        const h = hive.health();
        assert.equal(h.docker.running, true);
        assert.notOk(h.disk.usage);
    });

    it('reports image age in hours when less than a day old', () => {
        tmp = tmpDir();
        const imageDate = new Date(Date.now() - 5 * 60 * 60 * 1000); // 5 hours ago
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.includes('info')) return '24.0.0\n';
                if (cmd.includes('image inspect')) return JSON.stringify(imageDate.toISOString()) + '\n';
                if (cmd.includes('system df')) return JSON.stringify({ Type: 'Images', TotalCount: '1', Reclaimable: '0B' }) + '\n';
                return '';
            }
        });

        const h = hive.health();
        assert.equal(h.image.exists, true);
        assert.equal(h.image.age, '5h');
    });
});

// ─── Network: Inter-Minion Messaging ─────────────────────────────────

describe('Hive.send', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('sends a message between two minions', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'alice');
        writeMinionFixture(hive.minionsDir, 'bob');

        const msg = hive.send('alice', 'bob', 'hello bob');
        assert.equal(msg.from, 'alice');
        assert.equal(msg.to, 'bob');
        assert.equal(msg.body, 'hello bob');
        assert.ok(msg.id);
        assert.ok(msg.timestamp);
    });

    it('writes message file to recipient inbox', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'alice');
        writeMinionFixture(hive.minionsDir, 'bob');

        hive.send('alice', 'bob', 'test message');
        const inboxDir = path.join(hive.networkDir, 'bob');
        const files = fs.readdirSync(inboxDir);
        assert.equal(files.length, 1);
        assert.ok(files[0].endsWith('.json'));
    });

    it('throws when sender does not exist', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'bob');

        assert.throws(() => hive.send('ghost', 'bob', 'hey'), "Sender minion 'ghost' not found");
    });

    it('throws when recipient does not exist', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'alice');

        assert.throws(() => hive.send('alice', 'ghost', 'hey'), "Recipient minion 'ghost' not found");
    });

    it('supports multiple messages to same recipient', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'alice');
        writeMinionFixture(hive.minionsDir, 'bob');

        hive.send('alice', 'bob', 'msg 1');
        hive.send('alice', 'bob', 'msg 2');

        const inboxDir = path.join(hive.networkDir, 'bob');
        const files = fs.readdirSync(inboxDir);
        assert.equal(files.length, 2);
    });
});

describe('Hive.inbox', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('returns empty array when no messages', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'alice');

        const messages = hive.inbox('alice');
        assert.deepEqual(messages, []);
    });

    it('returns messages sorted by time', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'alice');
        writeMinionFixture(hive.minionsDir, 'bob');
        writeMinionFixture(hive.minionsDir, 'charlie');

        hive.send('bob', 'alice', 'first');
        hive.send('charlie', 'alice', 'second');

        const messages = hive.inbox('alice');
        assert.equal(messages.length, 2);
        assert.equal(messages[0].body, 'first');
        assert.equal(messages[1].body, 'second');
    });

    it('throws when minion does not exist', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);

        assert.throws(() => hive.inbox('ghost'), "Minion 'ghost' not found");
    });

    it('returns parsed message objects', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'alice');
        writeMinionFixture(hive.minionsDir, 'bob');

        hive.send('bob', 'alice', 'hello');
        const messages = hive.inbox('alice');
        assert.equal(messages[0].from, 'bob');
        assert.equal(messages[0].to, 'alice');
        assert.equal(messages[0].body, 'hello');
    });
});

describe('Hive.broadcast', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('sends to all other minions', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'alice');
        writeMinionFixture(hive.minionsDir, 'bob');
        writeMinionFixture(hive.minionsDir, 'charlie');

        const sent = hive.broadcast('alice', 'hello everyone');
        assert.equal(sent.length, 2);
        assert.equal(sent[0].to, 'bob');
        assert.equal(sent[1].to, 'charlie');
    });

    it('does not send to self', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'alice');
        writeMinionFixture(hive.minionsDir, 'bob');

        hive.broadcast('alice', 'hello');
        const own = hive.inbox('alice');
        assert.equal(own.length, 0);
    });

    it('throws when sender does not exist', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);

        assert.throws(() => hive.broadcast('ghost', 'hey'), /Sender minion 'ghost' not found/);
    });

    it('returns empty array when no other minions', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'alice');

        const sent = hive.broadcast('alice', 'hello?');
        assert.equal(sent.length, 0);
    });
});

describe('Hive.clearInbox', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('clears all messages from inbox', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'alice');
        writeMinionFixture(hive.minionsDir, 'bob');

        hive.send('bob', 'alice', 'msg 1');
        hive.send('bob', 'alice', 'msg 2');

        const result = hive.clearInbox('alice');
        assert.equal(result.cleared, 2);

        const messages = hive.inbox('alice');
        assert.equal(messages.length, 0);
    });

    it('returns zero when inbox is empty', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'alice');

        const result = hive.clearInbox('alice');
        assert.equal(result.cleared, 0);
    });

    it('throws when minion does not exist', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);

        assert.throws(() => hive.clearInbox('ghost'), /Minion 'ghost' not found/);
    });

    it('returns name in result', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'alice');

        const result = hive.clearInbox('alice');
        assert.equal(result.name, 'alice');
    });
});

// ─── Prune ────────────────────────────────────────────────────────────

describe('Hive.prune()', () => {
    let tmp, hive;

    afterEach(() => {
        if (tmp) tmp.cleanup();
    });

    it('returns empty array when no completed minions', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        
        // Create a working minion
        const minionDir = path.join(hive.minionsDir, 'worker-1');
        fs.mkdirSync(minionDir, { recursive: true });
        fs.writeFileSync(path.join(minionDir, 'meta.json'), JSON.stringify({
            name: 'worker-1',
            createdAt: new Date(Date.now() - 86400000 * 10).toISOString(),
            status: 'running'
        }));
        fs.writeFileSync(path.join(minionDir, 'STATUS'), 'WORKING');

        const pruned = hive.prune();
        assert.deepEqual(pruned, []);
    });

    it('prunes completed minions older than threshold', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        
        // Create an old completed minion
        const oldDir = path.join(hive.minionsDir, 'old-worker');
        fs.mkdirSync(oldDir, { recursive: true });
        fs.writeFileSync(path.join(oldDir, 'meta.json'), JSON.stringify({
            name: 'old-worker',
            createdAt: new Date(Date.now() - 86400000 * 10).toISOString()
        }));
        fs.writeFileSync(path.join(oldDir, 'STATUS'), 'COMPLETE');

        const pruned = hive.prune({ olderThan: '7d' });
        assert.equal(pruned.length, 1);
        assert.equal(pruned[0].name, 'old-worker');
        assert.ok(!fs.existsSync(oldDir), 'workspace should be removed');
    });

    it('keeps completed minions newer than threshold', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        
        // Create a recent completed minion
        const recentDir = path.join(hive.minionsDir, 'recent-worker');
        fs.mkdirSync(recentDir, { recursive: true });
        fs.writeFileSync(path.join(recentDir, 'meta.json'), JSON.stringify({
            name: 'recent-worker',
            createdAt: new Date(Date.now() - 3600000).toISOString() // 1 hour ago
        }));
        fs.writeFileSync(path.join(recentDir, 'STATUS'), 'COMPLETE');

        const pruned = hive.prune({ olderThan: '7d' });
        assert.equal(pruned.length, 0);
        assert.ok(fs.existsSync(recentDir), 'workspace should still exist');
    });

    it('prunes FAILED minions too', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        
        const failedDir = path.join(hive.minionsDir, 'failed-worker');
        fs.mkdirSync(failedDir, { recursive: true });
        fs.writeFileSync(path.join(failedDir, 'meta.json'), JSON.stringify({
            name: 'failed-worker',
            createdAt: new Date(Date.now() - 86400000 * 10).toISOString()
        }));
        fs.writeFileSync(path.join(failedDir, 'STATUS'), 'FAILED');

        const pruned = hive.prune({ olderThan: '7d' });
        assert.equal(pruned.length, 1);
        assert.equal(pruned[0].status, 'FAILED');
    });

    it('--all ignores age and prunes everything completed', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        
        // Create a recent completed minion
        const recentDir = path.join(hive.minionsDir, 'recent-worker');
        fs.mkdirSync(recentDir, { recursive: true });
        fs.writeFileSync(path.join(recentDir, 'meta.json'), JSON.stringify({
            name: 'recent-worker',
            createdAt: new Date().toISOString() // just now
        }));
        fs.writeFileSync(path.join(recentDir, 'STATUS'), 'COMPLETE');

        const pruned = hive.prune({ all: true });
        assert.equal(pruned.length, 1);
        assert.ok(!fs.existsSync(recentDir), 'workspace should be removed');
    });

    it('--dry-run does not actually remove anything', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        
        const oldDir = path.join(hive.minionsDir, 'old-worker');
        fs.mkdirSync(oldDir, { recursive: true });
        fs.writeFileSync(path.join(oldDir, 'meta.json'), JSON.stringify({
            name: 'old-worker',
            createdAt: new Date(Date.now() - 86400000 * 10).toISOString()
        }));
        fs.writeFileSync(path.join(oldDir, 'STATUS'), 'COMPLETE');

        const pruned = hive.prune({ olderThan: '7d', dryRun: true });
        assert.equal(pruned.length, 1);
        assert.ok(fs.existsSync(oldDir), 'workspace should still exist (dry run)');
    });

    it('parses age formats correctly', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        
        // Test 24h format
        const oldDir = path.join(hive.minionsDir, 'old-worker');
        fs.mkdirSync(oldDir, { recursive: true });
        fs.writeFileSync(path.join(oldDir, 'meta.json'), JSON.stringify({
            name: 'old-worker',
            createdAt: new Date(Date.now() - 86400000 * 2).toISOString() // 2 days ago
        }));
        fs.writeFileSync(path.join(oldDir, 'STATUS'), 'COMPLETE');

        const pruned = hive.prune({ olderThan: '24h' });
        assert.equal(pruned.length, 1);
    });

    it('throws on invalid age format', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);

        assert.throws(() => hive.prune({ olderThan: 'invalid' }), /Invalid age format/);
    });
});

// ─── Retry ────────────────────────────────────────────────────────────

describe('Hive.retry', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('throws when minion does not exist', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.throws(() => hive.retry('ghost'), 'not found');
    });

    it('throws when minion has no TASK.md', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        const minionDir = path.join(hive.minionsDir, 'no-task');
        fs.mkdirSync(minionDir, { recursive: true });
        fs.writeFileSync(path.join(minionDir, 'meta.json'), JSON.stringify({
            name: 'no-task', createdAt: '2026-01-01T00:00:00.000Z',
            task: 'test', status: 'running', containerId: 'sha256:abc'
        }));
        assert.throws(() => hive.retry('no-task'), 'no TASK.md');
    });

    it('kills old container via docker stop and rm', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'r1', {
            taskStatus: 'FAILED',
            containerId: 'sha256:r1',
            taskContent: 'Build something'
        });

        hive.retry('r1');
        const stopCall = hive._dockerCalls.find(c => c.startsWith('stop'));
        const rmCall = hive._dockerCalls.find(c => c.startsWith('rm'));
        assert.ok(stopCall);
        assert.ok(rmCall);
        assert.includes(stopCall, 'hive-r1');
        assert.includes(rmCall, 'hive-r1');
    });

    it('does not throw if old container is already gone', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.startsWith('stop') || cmd.startsWith('rm hive-')) {
                    throw new Error('no such container');
                }
                if (cmd.includes('image inspect')) return '[]';
                if (cmd.startsWith('run ')) return 'newcontainer123\n';
                return '';
            }
        });
        writeMinionFixture(hive.minionsDir, 'gone', {
            taskStatus: 'COMPLETE',
            containerId: 'sha256:gone',
            taskContent: 'Do stuff'
        });

        assert.doesNotThrow(() => hive.retry('gone'));
    });

    it('clears STATUS file', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'st', {
            taskStatus: 'FAILED',
            taskContent: 'A task'
        });

        hive.retry('st');
        const statusPath = path.join(hive.minionsDir, 'st', 'STATUS');
        assert.notOk(fs.existsSync(statusPath));
    });

    it('clears and recreates output directory', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'out', {
            taskStatus: 'COMPLETE',
            output: 'old output data',
            taskContent: 'A task'
        });

        hive.retry('out');
        const outputDir = path.join(hive.minionsDir, 'out', 'output');
        assert.ok(fs.existsSync(outputDir));
        const outputLog = path.join(outputDir, 'claude-output.log');
        assert.notOk(fs.existsSync(outputLog));
    });

    it('starts a new container with same task', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'task-test', {
            taskStatus: 'FAILED',
            taskContent: 'Build a REST API'
        });

        hive.retry('task-test');
        const runCall = hive._dockerCalls.find(c => c.startsWith('run'));
        assert.ok(runCall);
        assert.includes(runCall, 'hive-task-test');
    });

    it('returns name, containerId, and minionDir', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'ret', {
            taskStatus: 'COMPLETE',
            taskContent: 'A task'
        });

        const result = hive.retry('ret');
        assert.equal(result.name, 'ret');
        assert.equal(result.containerId, 'abc123containerid');
        assert.equal(result.minionDir, path.join(tmp.dir, 'minions', 'ret'));
    });

    it('updates meta.json with running status and retriedAt', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'meta-retry', {
            taskStatus: 'FAILED',
            taskContent: 'A task'
        });

        hive.retry('meta-retry');
        const meta = JSON.parse(fs.readFileSync(
            path.join(hive.minionsDir, 'meta-retry', 'meta.json'), 'utf8'
        ));
        assert.equal(meta.status, 'running');
        assert.equal(meta.name, 'meta-retry');
        assert.ok(meta.retriedAt);
        assert.ok(meta.retryOf);
        assert.equal(meta.containerId, 'abc123containerid');
    });

    it('preserves original TASK.md content', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'task-keep', {
            taskStatus: 'COMPLETE',
            taskContent: 'Build a CLI tool with Node.js'
        });

        hive.retry('task-keep');
        const task = fs.readFileSync(
            path.join(hive.minionsDir, 'task-keep', 'TASK.md'), 'utf8'
        );
        assert.equal(task, 'Build a CLI tool with Node.js');
    });

    it('carries forward resource limits from old meta', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'res', {
            taskStatus: 'FAILED',
            taskContent: 'A task',
            extraMeta: { memory: '1g', cpus: '2' }
        });

        hive.retry('res');
        const runCall = hive._dockerCalls.find(c => c.startsWith('run'));
        assert.includes(runCall, '--memory=1g');
        assert.includes(runCall, '--cpus=2');
        const meta = JSON.parse(fs.readFileSync(
            path.join(hive.minionsDir, 'res', 'meta.json'), 'utf8'
        ));
        assert.equal(meta.memory, '1g');
        assert.equal(meta.cpus, '2');
    });

    it('allows overriding resource limits', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'override', {
            taskStatus: 'FAILED',
            taskContent: 'A task',
            extraMeta: { memory: '512m', cpus: '1' }
        });

        hive.retry('override', { memory: '2g', cpus: '4' });
        const runCall = hive._dockerCalls.find(c => c.startsWith('run'));
        assert.includes(runCall, '--memory=2g');
        assert.includes(runCall, '--cpus=4');
    });

    it('passes claudeToken env var when provided', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'tok', {
            taskStatus: 'COMPLETE',
            taskContent: 'A task'
        });

        hive.retry('tok', { claudeToken: 'mytoken' });
        const runCall = hive._dockerCalls.find(c => c.startsWith('run'));
        assert.includes(runCall, 'CLAUDE_CODE_OAUTH_TOKEN=mytoken');
    });
});

// ─── Hive.rename ─────────────────────────────────────────────────────

describe('Hive.rename', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('throws if source minion does not exist', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.throws(() => hive.rename('ghost', 'new-name'), 'not found');
    });

    it('throws if target name already exists', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'source');
        writeMinionFixture(hive.minionsDir, 'target');
        assert.throws(() => hive.rename('source', 'target'), 'already exists');
    });

    it('throws for invalid new name', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'source');
        assert.throws(() => hive.rename('source', 'bad name'), 'Invalid minion name');
        assert.throws(() => hive.rename('source', '.hidden'), 'Invalid minion name');
    });

    it('renames directory and updates metadata', () => {
        tmp = tmpDir();
        // Mock docker to return 'exited' status (stopped container)
        hive = createMockHive(tmp.dir, {
            _docker: (cmd) => {
                if (cmd.includes('inspect -f')) return "'exited'\n";
                return '';
            }
        });
        writeMinionFixture(hive.minionsDir, 'old-name', {
            taskContent: 'Test task'
        });

        const result = hive.rename('old-name', 'new-name');

        assert.equal(result.oldName, 'old-name');
        assert.equal(result.newName, 'new-name');
        assert.ok(!fs.existsSync(path.join(hive.minionsDir, 'old-name')));
        assert.ok(fs.existsSync(path.join(hive.minionsDir, 'new-name')));
    });

    it('updates meta.json with new name and renamedFrom', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker: (cmd) => {
                if (cmd.includes('inspect -f')) return "'exited'\n";
                return '';
            }
        });
        writeMinionFixture(hive.minionsDir, 'alpha');

        hive.rename('alpha', 'beta');

        const meta = JSON.parse(
            fs.readFileSync(path.join(hive.minionsDir, 'beta', 'meta.json'), 'utf8')
        );
        assert.equal(meta.name, 'beta');
        assert.equal(meta.renamedFrom, 'alpha');
        assert.ok(meta.renamedAt);
    });

    it('clears containerId in metadata after rename', () => {
        tmp = tmpDir();
        // Mock docker inspect to return 'exited' status
        hive = createMockHive(tmp.dir, {
            _docker: (cmd) => {
                if (cmd.includes('inspect -f')) return "'exited'\n";
                return '';
            }
        });
        writeMinionFixture(hive.minionsDir, 'withcontainer');

        hive.rename('withcontainer', 'renamed');

        const newMeta = JSON.parse(
            fs.readFileSync(path.join(hive.minionsDir, 'renamed', 'meta.json'), 'utf8')
        );
        assert.equal(newMeta.containerId, null);
    });

    it('renames network inbox if it exists', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker: (cmd) => {
                if (cmd.includes('inspect -f')) return "'exited'\n";
                return '';
            }
        });
        writeMinionFixture(hive.minionsDir, 'msg-source');
        
        // Create inbox with a message
        const inboxDir = path.join(hive.networkDir, 'msg-source');
        fs.mkdirSync(inboxDir, { recursive: true });
        fs.writeFileSync(path.join(inboxDir, 'test-msg.json'), '{"body": "hi"}');

        hive.rename('msg-source', 'msg-dest');

        assert.ok(!fs.existsSync(path.join(hive.networkDir, 'msg-source')));
        assert.ok(fs.existsSync(path.join(hive.networkDir, 'msg-dest')));
        assert.ok(fs.existsSync(path.join(hive.networkDir, 'msg-dest', 'test-msg.json')));
    });

    it('preserves workspace files during rename', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker: (cmd) => {
                if (cmd.includes('inspect -f')) return "'exited'\n";
                return '';
            }
        });
        writeMinionFixture(hive.minionsDir, 'files', {
            taskContent: 'My task content'
        });
        // Add extra file
        fs.writeFileSync(
            path.join(hive.minionsDir, 'files', 'output', 'result.txt'),
            'test output'
        );

        hive.rename('files', 'files-renamed');

        const taskContent = fs.readFileSync(
            path.join(hive.minionsDir, 'files-renamed', 'TASK.md'), 'utf8'
        );
        const outputContent = fs.readFileSync(
            path.join(hive.minionsDir, 'files-renamed', 'output', 'result.txt'), 'utf8'
        );
        assert.equal(taskContent, 'My task content');
        assert.equal(outputContent, 'test output');
    });

    it('throws when trying to rename a running minion', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'running-minion');

        assert.throws(
            () => hive.rename('running-minion', 'new-name'),
            'Cannot rename running minion'
        );
    });
});

// ─── _parseMemory ────────────────────────────────────────────────────

describe('Hive._parseMemory', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('parses MiB values', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.equal(hive._parseMemory('50MiB'), 50 * 1024 * 1024);
    });

    it('parses GiB values', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.equal(hive._parseMemory('1.5GiB'), 1.5 * 1024 * 1024 * 1024);
    });

    it('parses KiB values', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.equal(hive._parseMemory('512KiB'), 512 * 1024);
    });

    it('parses B values', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.equal(hive._parseMemory('1024B'), 1024);
    });

    it('returns 0 for unparseable strings', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        assert.equal(hive._parseMemory('unknown'), 0);
        assert.equal(hive._parseMemory(''), 0);
    });
});

// ─── aggregateStats ──────────────────────────────────────────────────

describe('Hive.aggregateStats', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('returns zeroed stats when no minions exist', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);

        const s = hive.aggregateStats();
        assert.equal(s.minions.running, 0);
        assert.equal(s.minions.stopped, 0);
        assert.equal(s.minions.total, 0);
        assert.equal(s.resources.cpu, 0);
        assert.equal(s.resources.memoryBytes, 0);
        assert.equal(s.uptime.oldest, null);
        assert.equal(s.templates, 0);
    });

    it('counts running and stopped minions', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.includes('inspect -f') && cmd.includes('hive-w1')) return "'running'\n";
                if (cmd.includes('inspect -f') && cmd.includes('hive-w2')) return "'running'\n";
                if (cmd.includes('inspect -f') && cmd.includes('hive-w3')) return "'exited'\n";
                if (cmd.includes('stats')) return JSON.stringify({ CPUPerc: '0%', MemUsage: '0B / 0B' });
                return '';
            }
        });
        writeMinionFixture(hive.minionsDir, 'w1', { containerId: 'sha256:w1' });
        writeMinionFixture(hive.minionsDir, 'w2', { containerId: 'sha256:w2' });
        writeMinionFixture(hive.minionsDir, 'w3', { containerId: 'sha256:w3' });

        const s = hive.aggregateStats();
        assert.equal(s.minions.running, 2);
        assert.equal(s.minions.stopped, 1);
        assert.equal(s.minions.total, 3);
    });

    it('aggregates CPU and memory from running containers', () => {
        tmp = tmpDir();
        let callCount = 0;
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.includes('inspect -f')) return "'running'\n";
                if (cmd.includes('stats')) {
                    callCount++;
                    if (callCount === 1) {
                        return JSON.stringify({ CPUPerc: '20.5%', MemUsage: '100MiB / 1GiB' });
                    }
                    return JSON.stringify({ CPUPerc: '30%', MemUsage: '200MiB / 1GiB' });
                }
                return '';
            }
        });
        writeMinionFixture(hive.minionsDir, 'a', { containerId: 'sha256:a' });
        writeMinionFixture(hive.minionsDir, 'b', { containerId: 'sha256:b' });

        const s = hive.aggregateStats();
        assert.equal(s.resources.cpu, 50.5);
        assert.equal(s.resources.memoryBytes, 300 * 1024 * 1024);
    });

    it('computes uptime stats for running minions', () => {
        tmp = tmpDir();
        const now = Date.now();
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.includes('inspect -f')) return "'running'\n";
                if (cmd.includes('stats')) return JSON.stringify({ CPUPerc: '0%', MemUsage: '0B / 0B' });
                return '';
            }
        });
        // One created 2 days ago, one 1 hour ago
        writeMinionFixture(hive.minionsDir, 'old', {
            containerId: 'sha256:old',
            createdAt: new Date(now - 2 * 86400000).toISOString()
        });
        writeMinionFixture(hive.minionsDir, 'new', {
            containerId: 'sha256:new',
            createdAt: new Date(now - 3600000).toISOString()
        });

        const s = hive.aggregateStats();
        assert.ok(s.uptime.oldest);
        assert.ok(s.uptime.newest);
        assert.ok(s.uptime.average);
        assert.includes(s.uptime.oldest, '2d');
        assert.includes(s.uptime.newest, '1h');
    });

    it('counts templates', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        hive.templateSave('tpl-1', 'content 1');
        hive.templateSave('tpl-2', 'content 2');

        const s = hive.aggregateStats();
        assert.equal(s.templates, 2);
    });

    it('handles docker stats failures gracefully', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.includes('inspect -f')) return "'running'\n";
                if (cmd.includes('stats')) throw new Error('container not running');
                return '';
            }
        });
        writeMinionFixture(hive.minionsDir, 'fail', { containerId: 'sha256:fail' });

        const s = hive.aggregateStats();
        assert.equal(s.minions.running, 1);
        assert.equal(s.resources.cpu, 0);
        assert.equal(s.resources.memoryBytes, 0);
    });

    it('returns null uptime fields when no running minions', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir, {
            _docker(cmd) {
                if (cmd.includes('inspect -f')) return "'exited'\n";
                return '';
            }
        });
        writeMinionFixture(hive.minionsDir, 'stopped', { containerId: 'sha256:stopped' });

        const s = hive.aggregateStats();
        assert.equal(s.uptime.oldest, null);
        assert.equal(s.uptime.newest, null);
        assert.equal(s.uptime.average, null);
    });
});

// ─── checkAndStartDependents ─────────────────────────────────────────

describe('Hive.checkAndStartDependents', () => {
    afterEach(() => { if (tmp) tmp.cleanup(); });

    it('returns empty array when no waiting minions exist', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'running-1', {
            status: 'running',
            containerId: 'sha256:r1'
        });

        const started = hive.checkAndStartDependents();
        assert.deepEqual(started, []);
    });

    it('starts waiting minion when dependency has STATUS=COMPLETE', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        // Create dependency minion with COMPLETE status
        writeMinionFixture(hive.minionsDir, 'step-1', {
            taskStatus: 'COMPLETE',
            taskContent: 'First task'
        });
        // Create waiting minion that depends on step-1
        hive.spawnWaiting('step-2', 'Second task', 'step-1');

        const started = hive.checkAndStartDependents();
        assert.equal(started.length, 1);
        assert.equal(started[0].name, 'step-2');
        assert.equal(started[0].dependsOn, 'step-1');

        // Verify meta was updated to running
        const meta = JSON.parse(fs.readFileSync(
            path.join(hive.minionsDir, 'step-2', 'meta.json'), 'utf8'
        ));
        assert.equal(meta.status, 'running');
    });

    it('does not start when dependency STATUS is WORKING', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'dep', {
            taskStatus: 'WORKING',
            taskContent: 'Working task'
        });
        hive.spawnWaiting('waiter', 'Waiting task', 'dep');

        const started = hive.checkAndStartDependents();
        assert.deepEqual(started, []);

        // Verify still waiting
        const meta = JSON.parse(fs.readFileSync(
            path.join(hive.minionsDir, 'waiter', 'meta.json'), 'utf8'
        ));
        assert.equal(meta.status, 'waiting');
    });

    it('does not start when dependency has no STATUS file', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        // Create dep without STATUS file
        writeMinionFixture(hive.minionsDir, 'dep', {
            taskContent: 'Running task'
        });
        hive.spawnWaiting('waiter', 'Waiting task', 'dep');

        const started = hive.checkAndStartDependents();
        assert.deepEqual(started, []);
    });

    it('does not start non-waiting minions', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        // Create a running minion with dependsOn set (shouldn't be started again)
        writeMinionFixture(hive.minionsDir, 'dep', {
            taskStatus: 'COMPLETE',
            taskContent: 'Done'
        });
        writeMinionFixture(hive.minionsDir, 'already-running', {
            status: 'running',
            containerId: 'sha256:ar',
            extraMeta: { dependsOn: 'dep' }
        });

        const started = hive.checkAndStartDependents();
        assert.deepEqual(started, []);
    });

    it('starts multiple waiting minions in one pass', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        // Create completed dependency
        writeMinionFixture(hive.minionsDir, 'dep', {
            taskStatus: 'COMPLETE',
            taskContent: 'Done'
        });
        // Create two waiting minions depending on the same dep
        hive.spawnWaiting('waiter-a', 'Task A', 'dep');
        hive.spawnWaiting('waiter-b', 'Task B', 'dep');

        const started = hive.checkAndStartDependents();
        assert.equal(started.length, 2);
        const names = started.map(s => s.name).sort();
        assert.deepEqual(names, ['waiter-a', 'waiter-b']);
    });

    it('handles chain: A->B->C (only starts B when A completes, not C)', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        // A is complete
        writeMinionFixture(hive.minionsDir, 'A', {
            taskStatus: 'COMPLETE',
            taskContent: 'Task A'
        });
        // B waits on A
        hive.spawnWaiting('B', 'Task B', 'A');
        // C waits on B
        hive.spawnWaiting('C', 'Task C', 'B');

        const started = hive.checkAndStartDependents();
        // Only B should start (A is complete), C should not (B has no STATUS file yet)
        assert.equal(started.length, 1);
        assert.equal(started[0].name, 'B');
        assert.equal(started[0].dependsOn, 'A');

        // Verify C is still waiting
        const metaC = JSON.parse(fs.readFileSync(
            path.join(hive.minionsDir, 'C', 'meta.json'), 'utf8'
        ));
        assert.equal(metaC.status, 'waiting');
    });

    it('passes options through to start()', () => {
        tmp = tmpDir();
        hive = createMockHive(tmp.dir);
        writeMinionFixture(hive.minionsDir, 'dep', {
            taskStatus: 'COMPLETE',
            taskContent: 'Done'
        });
        hive.spawnWaiting('waiter', 'Task', 'dep');

        hive.checkAndStartDependents({ claudeToken: 'mytoken', keepAlive: true });

        const runCall = hive._dockerCalls.find(c => c.startsWith('run'));
        assert.ok(runCall);
        assert.includes(runCall, 'CLAUDE_CODE_OAUTH_TOKEN=mytoken');
        assert.includes(runCall, 'KEEP_ALIVE=true');
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
