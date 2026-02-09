/**
 * Hive - AI Minion Orchestration
 * 
 * Core library for spawning and managing AI agent minions in Docker containers.
 */

const { execSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HIVE_DIR = process.env.HIVE_DIR || path.join(process.env.HOME, '.hive');
const IMAGE_NAME = 'cortex/hive-minion';

class Hive {
    constructor(options = {}) {
        this.hiveDir = options.hiveDir || HIVE_DIR;
        this.minionsDir = path.join(this.hiveDir, 'minions');
        this.templatesDir = path.join(this.hiveDir, 'templates');
        this.networkDir = path.join(this.hiveDir, 'network');
        this.useSudo = options.useSudo !== false; // Default to sudo for Docker
        this._ensureDirs();
    }

    /**
     * Validate a minion name for use as directory and Docker container name
     */
    _validateName(name) {
        if (!name || typeof name !== 'string') {
            throw new Error('Minion name is required');
        }
        if (name.length > 128) {
            throw new Error(`Minion name too long (${name.length} chars, max 128)`);
        }
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
            throw new Error(
                `Invalid minion name '${name}'. Names must start with a letter or number and contain only letters, numbers, hyphens, underscores, and dots.`
            );
        }
    }

    _ensureDirs() {
        if (!fs.existsSync(this.hiveDir)) fs.mkdirSync(this.hiveDir, { recursive: true });
        if (!fs.existsSync(this.minionsDir)) fs.mkdirSync(this.minionsDir, { recursive: true });
        if (!fs.existsSync(this.templatesDir)) fs.mkdirSync(this.templatesDir, { recursive: true });
        if (!fs.existsSync(this.networkDir)) fs.mkdirSync(this.networkDir, { recursive: true });
    }

    _docker(cmd) {
        const prefix = this.useSudo ? 'sudo docker' : 'docker';
        return execSync(`${prefix} ${cmd}`, { encoding: 'utf8' });
    }

    _dockerAsync(args) {
        const dockerCmd = this.useSudo ? 'sudo' : 'docker';
        const dockerArgs = this.useSudo ? ['docker', ...args] : args;
        return spawn(dockerCmd, dockerArgs);
    }

    /**
     * Build the minion Docker image
     */
    buildImage(dockerfilePath) {
        console.log('Building minion image...');
        const result = this._docker(`build -t ${IMAGE_NAME} ${dockerfilePath}`);
        console.log(result);
        return true;
    }

    /**
     * Check if minion image exists
     */
    imageExists() {
        try {
            this._docker(`image inspect ${IMAGE_NAME}`);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Spawn a new minion with a task
     */
    spawn(name, task, options = {}) {
        this._validateName(name);
        const minionDir = path.join(this.minionsDir, name);

        if (fs.existsSync(minionDir)) {
            throw new Error(`Minion ${name} already exists`);
        }

        // Create minion workspace
        fs.mkdirSync(minionDir, { recursive: true, mode: 0o777 });
        fs.mkdirSync(path.join(minionDir, 'output'), { recursive: true, mode: 0o777 });
        
        // Make workspace writable by container user
        fs.chmodSync(minionDir, 0o777);
        fs.chmodSync(path.join(minionDir, 'output'), 0o777);
        
        // Write task file
        fs.writeFileSync(path.join(minionDir, 'TASK.md'), task, { mode: 0o666 });
        
        // Write metadata
        const meta = {
            name,
            createdAt: new Date().toISOString(),
            task: task.substring(0, 200),
            status: 'pending',
            containerId: null
        };
        fs.writeFileSync(path.join(minionDir, 'meta.json'), JSON.stringify(meta, null, 2));

        // Build image if needed
        if (!this.imageExists()) {
            const projectDir = path.dirname(__dirname);
            this.buildImage(path.join(projectDir, 'hive'));
        }

        // Environment variables
        const envVars = [];
        if (options.claudeToken) {
            envVars.push(`-e CLAUDE_CODE_OAUTH_TOKEN=${options.claudeToken}`);
        }
        if (options.keepAlive) {
            envVars.push('-e KEEP_ALIVE=true');
        }

        // Resource limits
        const resourceArgs = [];
        if (options.memory) {
            resourceArgs.push(`--memory=${options.memory}`);
        }
        if (options.cpus) {
            resourceArgs.push(`--cpus=${options.cpus}`);
        }

        // Start container
        const envStr = envVars.join(' ');
        const resourceStr = resourceArgs.join(' ');
        const containerId = this._docker(
            `run -d --name hive-${name} ${envStr} ${resourceStr} -v ${minionDir}:/home/minion/workspace ${IMAGE_NAME}`
        ).trim();

        // Update metadata
        meta.containerId = containerId;
        meta.status = 'running';
        if (options.memory) meta.memory = options.memory;
        if (options.cpus) meta.cpus = options.cpus;
        fs.writeFileSync(path.join(minionDir, 'meta.json'), JSON.stringify(meta, null, 2));

        return { name, containerId, minionDir };
    }

    /**
     * Create a minion in 'waiting' state that depends on another minion completing first.
     * The container is NOT started - use start() to launch it after the dependency completes.
     * @param {string} name - Name for the new minion
     * @param {string} task - Task description
     * @param {string} afterMinion - Name of the dependency minion
     * @param {Object} options - Spawn options (memory, cpus)
     * @returns {{ name, minionDir, status, dependsOn }}
     */
    spawnWaiting(name, task, afterMinion, options = {}) {
        this._validateName(name);
        const minionDir = path.join(this.minionsDir, name);

        if (fs.existsSync(minionDir)) {
            throw new Error(`Minion ${name} already exists`);
        }

        // Verify dependency minion exists
        const depDir = path.join(this.minionsDir, afterMinion);
        if (!fs.existsSync(depDir)) {
            throw new Error(`Dependency minion '${afterMinion}' not found`);
        }

        // Create minion workspace
        fs.mkdirSync(minionDir, { recursive: true, mode: 0o777 });
        fs.mkdirSync(path.join(minionDir, 'output'), { recursive: true, mode: 0o777 });
        fs.chmodSync(minionDir, 0o777);
        fs.chmodSync(path.join(minionDir, 'output'), 0o777);

        // Write task file
        fs.writeFileSync(path.join(minionDir, 'TASK.md'), task, { mode: 0o666 });

        // Write metadata with waiting status
        const meta = {
            name,
            createdAt: new Date().toISOString(),
            task: task.substring(0, 200),
            status: 'waiting',
            containerId: null,
            dependsOn: afterMinion
        };
        if (options.memory) meta.memory = options.memory;
        if (options.cpus) meta.cpus = options.cpus;
        fs.writeFileSync(path.join(minionDir, 'meta.json'), JSON.stringify(meta, null, 2));

        return { name, minionDir, status: 'waiting', dependsOn: afterMinion };
    }

    /**
     * Start a pending/waiting minion by creating and running its container.
     * @param {string} name - Name of the minion to start
     * @param {Object} options - Start options (claudeToken, keepAlive, memory, cpus)
     * @returns {{ name, containerId, minionDir }}
     */
    start(name, options = {}) {
        const minionDir = path.join(this.minionsDir, name);

        if (!fs.existsSync(minionDir)) {
            throw new Error(`Minion '${name}' not found`);
        }

        const metaPath = path.join(minionDir, 'meta.json');
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

        if (meta.status !== 'pending' && meta.status !== 'waiting') {
            throw new Error(`Minion '${name}' is ${meta.status}, not pending/waiting`);
        }

        const taskPath = path.join(minionDir, 'TASK.md');
        if (!fs.existsSync(taskPath)) {
            throw new Error(`Minion '${name}' has no TASK.md`);
        }

        // Build image if needed
        if (!this.imageExists()) {
            const projectDir = path.dirname(__dirname);
            this.buildImage(path.join(projectDir, 'hive'));
        }

        // Carry forward resource limits from meta unless overridden
        const memory = options.memory || meta.memory;
        const cpus = options.cpus || meta.cpus;

        // Environment variables
        const envVars = [];
        if (options.claudeToken) {
            envVars.push(`-e CLAUDE_CODE_OAUTH_TOKEN=${options.claudeToken}`);
        }
        if (options.keepAlive) {
            envVars.push('-e KEEP_ALIVE=true');
        }

        // Resource limits
        const resourceArgs = [];
        if (memory) {
            resourceArgs.push(`--memory=${memory}`);
        }
        if (cpus) {
            resourceArgs.push(`--cpus=${cpus}`);
        }

        // Start container
        const envStr = envVars.join(' ');
        const resourceStr = resourceArgs.join(' ');
        const containerId = this._docker(
            `run -d --name hive-${name} ${envStr} ${resourceStr} -v ${minionDir}:/home/minion/workspace ${IMAGE_NAME}`
        ).trim();

        // Update metadata
        meta.containerId = containerId;
        meta.status = 'running';
        meta.startedAt = new Date().toISOString();
        if (memory) meta.memory = memory;
        if (cpus) meta.cpus = cpus;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

        return { name, containerId, minionDir };
    }

    /**
     * Check all waiting minions and start those whose dependencies have completed.
     * @param {Object} options - Options to pass to start() (claudeToken, keepAlive, etc.)
     * @returns {Array<{name, dependsOn}>} - List of minions that were started
     */
    checkAndStartDependents(options = {}) {
        const started = [];
        const minions = this.list();

        for (const m of minions) {
            if (m.status !== 'waiting' || !m.dependsOn) continue;

            // Check if dependency completed
            const depStatusPath = path.join(this.minionsDir, m.dependsOn, 'STATUS');
            if (!fs.existsSync(depStatusPath)) continue;

            const depStatus = fs.readFileSync(depStatusPath, 'utf8').trim();
            if (depStatus === 'COMPLETE') {
                this.start(m.name, options);
                started.push({ name: m.name, dependsOn: m.dependsOn });
            }
        }
        return started;
    }

    /**
     * Watch for dependency completions and auto-start waiting minions.
     * Polls on an interval and calls checkAndStartDependents().
     * @param {Object} options - Watch options
     * @param {number} options.intervalMs - Poll interval in ms (default: 5000)
     * @param {string} options.claudeToken - Claude API token to pass to started minions
     * @param {boolean} options.keepAlive - Keep containers alive after task
     * @param {Function} options.onStart - Callback called for each auto-started minion
     * @returns {Promise<void>} - Resolves when stopped via SIGINT
     */
    async watchDeps(options = {}) {
        const intervalMs = options.intervalMs || 5000;
        const startOptions = { claudeToken: options.claudeToken, keepAlive: options.keepAlive };
        let running = true;

        const poll = () => {
            if (!running) return;
            const started = this.checkAndStartDependents(startOptions);
            for (const s of started) {
                if (options.onStart) options.onStart(s);
            }
        };

        // Allow external stop
        this._watchDepsStop = () => { running = false; };

        // Initial check
        poll();

        // Polling loop
        while (running) {
            await new Promise(resolve => setTimeout(resolve, intervalMs));
            poll();
        }
    }

    /**
     * List all minions
     */
    list() {
        const minions = [];
        
        if (!fs.existsSync(this.minionsDir)) return minions;
        
        for (const name of fs.readdirSync(this.minionsDir)) {
            const metaPath = path.join(this.minionsDir, name, 'meta.json');
            if (fs.existsSync(metaPath)) {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                
                // Check container status
                if (meta.containerId) {
                    try {
                        const status = this._docker(`inspect -f '{{.State.Status}}' hive-${name}`).trim();
                        meta.containerStatus = status;
                    } catch {
                        meta.containerStatus = 'removed';
                    }
                }
                
                // Check STATUS file
                const statusPath = path.join(this.minionsDir, name, 'STATUS');
                if (fs.existsSync(statusPath)) {
                    meta.taskStatus = fs.readFileSync(statusPath, 'utf8').trim();
                }
                
                minions.push(meta);
            }
        }
        
        return minions;
    }

    /**
     * Get minion status and output
     */
    status(name) {
        const minionDir = path.join(this.minionsDir, name);
        
        if (!fs.existsSync(minionDir)) {
            throw new Error(`Minion ${name} not found`);
        }

        const meta = JSON.parse(fs.readFileSync(path.join(minionDir, 'meta.json'), 'utf8'));
        
        // Get STATUS file
        const statusPath = path.join(minionDir, 'STATUS');
        if (fs.existsSync(statusPath)) {
            meta.taskStatus = fs.readFileSync(statusPath, 'utf8').trim();
        }

        // Get output if exists
        const outputPath = path.join(minionDir, 'output', 'claude-output.log');
        if (fs.existsSync(outputPath)) {
            meta.output = fs.readFileSync(outputPath, 'utf8');
        }

        // Get container logs
        if (meta.containerId) {
            try {
                meta.logs = this._docker(`logs hive-${name}`);
            } catch {
                meta.logs = '(container removed)';
            }
        }

        return meta;
    }

    /**
     * Collect output from a minion
     */
    collect(name) {
        const status = this.status(name);
        return {
            name,
            taskStatus: status.taskStatus,
            output: status.output,
            logs: status.logs
        };
    }

    /**
     * Wait for a minion to complete
     * @param {string} name - Minion name
     * @param {Object} options - Wait options
     * @param {number} options.timeoutMs - Timeout in milliseconds (default: 300000)
     * @param {number} options.pollMs - Poll interval in milliseconds (default: 2000)
     * @returns {Promise<{status: string, output?: string}>}
     */
    async wait(name, options = {}) {
        const timeoutMs = options.timeoutMs || 300000;
        const pollMs = options.pollMs || 2000;
        const startTime = Date.now();

        while (true) {
            const status = this.status(name);
            const taskStatus = status.taskStatus;

            if (taskStatus === 'COMPLETE') {
                return { status: 'COMPLETE', output: status.output };
            }

            if (taskStatus === 'FAILED') {
                return { status: 'FAILED', output: status.output };
            }

            // Check timeout
            if (Date.now() - startTime > timeoutMs) {
                return { status: 'TIMEOUT', output: status.output };
            }

            // Wait before next poll
            await new Promise(resolve => setTimeout(resolve, pollMs));
        }
    }

    /**
     * Get logs from a minion (last N lines)
     */
    logs(name, lines = 50) {
        const minionDir = path.join(this.minionsDir, name);
        
        if (!fs.existsSync(minionDir)) {
            throw new Error(`Minion ${name} not found`);
        }

        const meta = JSON.parse(fs.readFileSync(path.join(minionDir, 'meta.json'), 'utf8'));
        
        if (!meta.containerId) {
            throw new Error(`Minion ${name} has no container`);
        }

        try {
            return this._docker(`logs --tail ${lines} hive-${name}`);
        } catch (e) {
            throw new Error(`Failed to get logs: container may be removed`);
        }
    }

    /**
     * Stream logs from a minion (follow mode)
     * Returns a child process that streams logs to stdout/stderr
     */
    logsFollow(name, lines = 50) {
        const minionDir = path.join(this.minionsDir, name);
        
        if (!fs.existsSync(minionDir)) {
            throw new Error(`Minion ${name} not found`);
        }

        const meta = JSON.parse(fs.readFileSync(path.join(minionDir, 'meta.json'), 'utf8'));
        
        if (!meta.containerId) {
            throw new Error(`Minion ${name} has no container`);
        }

        const args = ['logs', '-f', '--tail', String(lines), `hive-${name}`];
        return this._dockerAsync(args);
    }

    /**
     * Kill a minion
     */
    kill(name) {
        const minionDir = path.join(this.minionsDir, name);
        
        if (!fs.existsSync(minionDir)) {
            throw new Error(`Minion ${name} not found`);
        }

        try {
            this._docker(`stop hive-${name}`);
            this._docker(`rm hive-${name}`);
        } catch (e) {
            // Container might already be stopped/removed
        }

        // Update metadata
        const metaPath = path.join(minionDir, 'meta.json');
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta.status = 'killed';
        meta.killedAt = new Date().toISOString();
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

        return { name, status: 'killed' };
    }

    /**
     * Execute a command inside a minion's container
     */
    exec(name, command = ['/bin/bash']) {
        const minionDir = path.join(this.minionsDir, name);

        if (!fs.existsSync(minionDir)) {
            throw new Error(`Minion ${name} not found`);
        }

        const meta = JSON.parse(fs.readFileSync(path.join(minionDir, 'meta.json'), 'utf8'));

        if (!meta.containerId) {
            throw new Error(`Minion ${name} has no container`);
        }

        const dockerCmd = this.useSudo ? 'sudo' : 'docker';
        const dockerArgs = this.useSudo
            ? ['docker', 'exec', '-it', `hive-${name}`, ...command]
            : ['exec', '-it', `hive-${name}`, ...command];

        const result = spawnSync(dockerCmd, dockerArgs, { stdio: 'inherit' });

        return result.status;
    }

    /**
     * Clean up completed/killed minions
     */
    cleanup(options = {}) {
        const minions = this.list();
        const cleaned = [];

        for (const minion of minions) {
            if (minion.taskStatus === 'COMPLETE' || minion.status === 'killed' || options.all) {
                const minionDir = path.join(this.minionsDir, minion.name);
                
                // Remove container if exists
                try {
                    this._docker(`rm -f hive-${minion.name}`);
                } catch {}

                // Remove directory if requested
                if (options.removeFiles) {
                    fs.rmSync(minionDir, { recursive: true });
                }

                cleaned.push(minion.name);
            }
        }

        return cleaned;
    }

    /**
     * Restart a stopped minion
     */
    restart(name) {
        const minionDir = path.join(this.minionsDir, name);
        
        if (!fs.existsSync(minionDir)) {
            throw new Error(`Minion ${name} not found`);
        }

        const metaPath = path.join(minionDir, 'meta.json');
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

        if (!meta.containerId) {
            throw new Error(`Minion ${name} has no container`);
        }

        try {
            this._docker(`restart hive-${name}`);
            meta.status = 'running';
            meta.restartedAt = new Date().toISOString();
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
            return { name, status: 'restarted' };
        } catch (e) {
            throw new Error(`Failed to restart minion: ${e.message}`);
        }
    }

    /**
     * Pause a running minion
     */
    pause(name) {
        const minionDir = path.join(this.minionsDir, name);
        
        if (!fs.existsSync(minionDir)) {
            throw new Error(`Minion ${name} not found`);
        }

        const metaPath = path.join(minionDir, 'meta.json');
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

        if (!meta.containerId) {
            throw new Error(`Minion ${name} has no container`);
        }

        try {
            this._docker(`pause hive-${name}`);
            meta.status = 'paused';
            meta.pausedAt = new Date().toISOString();
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
            return { name, status: 'paused' };
        } catch (e) {
            throw new Error(`Failed to pause minion: ${e.message}`);
        }
    }

    /**
     * Resume a paused minion
     */
    resume(name) {
        const minionDir = path.join(this.minionsDir, name);
        
        if (!fs.existsSync(minionDir)) {
            throw new Error(`Minion ${name} not found`);
        }

        const metaPath = path.join(minionDir, 'meta.json');
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

        if (!meta.containerId) {
            throw new Error(`Minion ${name} has no container`);
        }

        try {
            this._docker(`unpause hive-${name}`);
            meta.status = 'running';
            meta.resumedAt = new Date().toISOString();
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
            return { name, status: 'running' };
        } catch (e) {
            throw new Error(`Failed to resume minion: ${e.message}`);
        }
    }

    /**
     * Get resource stats for a minion
     */
    stats(name) {
        const minionDir = path.join(this.minionsDir, name);
        
        if (!fs.existsSync(minionDir)) {
            throw new Error(`Minion ${name} not found`);
        }

        const meta = JSON.parse(fs.readFileSync(path.join(minionDir, 'meta.json'), 'utf8'));

        if (!meta.containerId) {
            throw new Error(`Minion ${name} has no container`);
        }

        try {
            const statsOutput = this._docker(`stats hive-${name} --no-stream --format "{{json .}}"`);
            return JSON.parse(statsOutput.trim());
        } catch (e) {
            throw new Error(`Failed to get stats: container may not be running`);
        }
    }

    /**
     * Get stats for all running minions (for top command)
     */
    topOnce() {
        const minions = this.list();
        const running = minions.filter(m => m.containerStatus === 'running');
        
        if (running.length === 0) {
            return [];
        }
        
        const results = [];
        for (const m of running) {
            try {
                const statsOutput = this._docker(`stats hive-${m.name} --no-stream --format "{{json .}}"`);
                const stats = JSON.parse(statsOutput.trim());
                
                // Calculate uptime from createdAt
                const created = new Date(m.createdAt);
                const uptime = Date.now() - created.getTime();
                const hours = Math.floor(uptime / 3600000);
                const minutes = Math.floor((uptime % 3600000) / 60000);
                const uptimeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
                
                results.push({
                    name: m.name,
                    cpu: stats.CPUPerc || '0%',
                    mem: stats.MemUsage || '0B / 0B',
                    memPerc: stats.MemPerc || '0%',
                    status: m.taskStatus || 'WORKING',
                    uptime: uptimeStr
                });
            } catch {
                // Skip minions we can't get stats for
            }
        }
        return results;
    }

    /**
     * Save a task template
     */
    templateSave(name, content) {
        this._ensureDirs();
        const filePath = path.join(this.templatesDir, `${name}.md`);
        fs.writeFileSync(filePath, content);
        return { name, path: filePath };
    }

    /**
     * List all templates
     */
    templateList() {
        this._ensureDirs();
        if (!fs.existsSync(this.templatesDir)) return [];

        return fs.readdirSync(this.templatesDir)
            .filter(f => f.endsWith('.md'))
            .map(f => {
                const filePath = path.join(this.templatesDir, f);
                const content = fs.readFileSync(filePath, 'utf8');
                const stat = fs.statSync(filePath);
                return {
                    name: f.replace(/\.md$/, ''),
                    path: filePath,
                    size: stat.size,
                    modifiedAt: stat.mtime.toISOString(),
                    preview: content.substring(0, 100)
                };
            });
    }

    /**
     * Get a template's content
     */
    templateGet(name) {
        const filePath = path.join(this.templatesDir, `${name}.md`);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Template '${name}' not found`);
        }
        return fs.readFileSync(filePath, 'utf8');
    }

    /**
     * Run a health check on the hive system
     */
    health() {
        const result = {
            docker: { running: false },
            image: { exists: false, age: null, created: null },
            minions: { running: 0, total: 0, byStatus: {} },
            disk: { usage: null, total: null, available: null }
        };

        // 1. Check Docker daemon
        try {
            this._docker('info --format "{{.ServerVersion}}"');
            result.docker.running = true;
        } catch {
            return result;
        }

        // 2. Check Hive image
        try {
            const inspectJson = this._docker(`image inspect ${IMAGE_NAME} --format "{{json .Created}}"`);
            const created = new Date(JSON.parse(inspectJson.trim()));
            result.image.exists = true;
            result.image.created = created.toISOString();
            const ageMs = Date.now() - created.getTime();
            const days = Math.floor(ageMs / (1000 * 60 * 60 * 24));
            const hours = Math.floor((ageMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            result.image.age = days > 0 ? `${days}d ${hours}h` : `${hours}h`;
        } catch {
            // Image doesn't exist
        }

        // 3. Count minions
        try {
            const minions = this.list();
            result.minions.total = minions.length;
            for (const m of minions) {
                const raw = m.containerStatus || m.status || 'unknown';
                const s = raw.replace(/^'+|'+$/g, '');
                result.minions.byStatus[s] = (result.minions.byStatus[s] || 0) + 1;
                if (s === 'running') result.minions.running++;
            }
        } catch {
            // No minions dir or other issue
        }

        // 4. Docker disk usage
        try {
            const dfOutput = this._docker('system df --format "{{json .}}"');
            const lines = dfOutput.trim().split('\n');
            const parsed = lines.map(l => JSON.parse(l));
            result.disk.usage = parsed;
        } catch {
            // Disk info unavailable
        }

        return result;
    }

    /**
     * Delete a template
     */
    templateDelete(name) {
        const filePath = path.join(this.templatesDir, `${name}.md`);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Template '${name}' not found`);
        }
        fs.rmSync(filePath);
        return { name, deleted: true };
    }

    // ─── Network: Inter-Minion Messaging ─────────────────────────────

    _minionInbox(name) {
        const dir = path.join(this.networkDir, name);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    /**
     * Send a message from one minion to another
     */
    send(from, to, body) {
        // Verify both minions exist
        if (!fs.existsSync(path.join(this.minionsDir, from))) {
            throw new Error(`Sender minion '${from}' not found`);
        }
        if (!fs.existsSync(path.join(this.minionsDir, to))) {
            throw new Error(`Recipient minion '${to}' not found`);
        }

        const inbox = this._minionInbox(to);
        // Use high-resolution time + random suffix to ensure unique IDs even in tight loops
        const hrtime = process.hrtime.bigint();
        const rand = Math.random().toString(36).substring(2, 6);
        const id = `${hrtime}-${from}-${rand}`;
        const msg = {
            id,
            from,
            to,
            body,
            timestamp: new Date().toISOString()
        };
        fs.writeFileSync(path.join(inbox, `${id}.json`), JSON.stringify(msg, null, 2));
        return msg;
    }

    /**
     * Read a minion's inbox messages
     */
    inbox(name) {
        if (!fs.existsSync(path.join(this.minionsDir, name))) {
            throw new Error(`Minion '${name}' not found`);
        }

        const inboxDir = path.join(this.networkDir, name);
        if (!fs.existsSync(inboxDir)) return [];

        return fs.readdirSync(inboxDir)
            .filter(f => f.endsWith('.json'))
            .sort()
            .map(f => JSON.parse(fs.readFileSync(path.join(inboxDir, f), 'utf8')));
    }

    /**
     * Broadcast a message from one minion to all others
     */
    broadcast(from, body) {
        if (!fs.existsSync(path.join(this.minionsDir, from))) {
            throw new Error(`Sender minion '${from}' not found`);
        }

        const minions = this.list();
        const sent = [];
        for (const m of minions) {
            if (m.name !== from) {
                const msg = this.send(from, m.name, body);
                sent.push(msg);
            }
        }
        return sent;
    }

    /**
     * Clear a minion's inbox
     */
    clearInbox(name) {
        if (!fs.existsSync(path.join(this.minionsDir, name))) {
            throw new Error(`Minion '${name}' not found`);
        }

        const inboxDir = path.join(this.networkDir, name);
        if (!fs.existsSync(inboxDir)) return { name, cleared: 0 };

        const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json'));
        for (const f of files) {
            fs.rmSync(path.join(inboxDir, f));
        }
        return { name, cleared: files.length };
    }

    /**
     * Export a minion's workspace to a tarball
     */
    export(name, options = {}) {
        const minionDir = path.join(this.minionsDir, name);
        if (!fs.existsSync(minionDir)) {
            throw new Error(`Minion '${name}' not found`);
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const outputPath = options.output || path.join(process.cwd(), `${name}-${timestamp}.tar.gz`);

        // Build tar command
        let tarCmd = `tar -czf "${outputPath}" -C "${this.minionsDir}" "${name}"`;
        
        // Include logs if requested
        if (options.includeLogs) {
            const containerName = `hive-${name}`;
            try {
                const logs = this._docker(`logs ${containerName} 2>&1`);
                const logsPath = path.join(minionDir, 'container.log');
                fs.writeFileSync(logsPath, logs);
            } catch {
                // Container may not exist, skip logs
            }
        }

        // Include inbox if requested
        if (options.includeInbox) {
            const inboxDir = path.join(this.networkDir, name);
            if (fs.existsSync(inboxDir)) {
                const inboxCopy = path.join(minionDir, 'inbox');
                if (!fs.existsSync(inboxCopy)) {
                    fs.mkdirSync(inboxCopy, { recursive: true });
                }
                const messages = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json'));
                for (const msg of messages) {
                    fs.copyFileSync(path.join(inboxDir, msg), path.join(inboxCopy, msg));
                }
            }
        }

        execSync(tarCmd);

        const stat = fs.statSync(outputPath);
        return {
            name,
            path: outputPath,
            size: stat.size,
            sizeHuman: this._humanSize(stat.size)
        };
    }

    /**
     * Helper: human-readable file size
     */
    _humanSize(bytes) {
        const units = ['B', 'KB', 'MB', 'GB'];
        let i = 0;
        while (bytes >= 1024 && i < units.length - 1) {
            bytes /= 1024;
            i++;
        }
        return `${bytes.toFixed(1)}${units[i]}`;
    }

    /**
     * Import a minion from a tarball
     */
    import(tarPath, options = {}) {
        if (!fs.existsSync(tarPath)) {
            throw new Error(`Archive not found: ${tarPath}`);
        }

        // Extract to temp location to read the name
        const tempDir = path.join(this.hiveDir, '.import-temp');
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true });
        }
        fs.mkdirSync(tempDir, { recursive: true });

        execSync(`tar -xzf "${tarPath}" -C "${tempDir}"`);

        // Find the minion directory name
        const extracted = fs.readdirSync(tempDir);
        if (extracted.length !== 1) {
            fs.rmSync(tempDir, { recursive: true });
            throw new Error('Invalid archive: expected single minion directory');
        }

        const name = options.name || extracted[0];
        const sourcePath = path.join(tempDir, extracted[0]);
        const destPath = path.join(this.minionsDir, name);

        if (fs.existsSync(destPath) && !options.overwrite) {
            fs.rmSync(tempDir, { recursive: true });
            throw new Error(`Minion '${name}' already exists. Use --overwrite to replace.`);
        }

        // Move to minions directory
        if (fs.existsSync(destPath)) {
            fs.rmSync(destPath, { recursive: true });
        }
        fs.renameSync(sourcePath, destPath);
        fs.rmSync(tempDir, { recursive: true });

        // Update meta with import timestamp
        const metaPath = path.join(destPath, 'meta.json');
        if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            meta.importedAt = new Date().toISOString();
            if (options.name && options.name !== extracted[0]) {
                meta.originalName = extracted[0];
                meta.name = options.name;
            }
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        }

        return { name, path: destPath, imported: true };
    }

    /**
     * Clone a minion (copy task and optionally workspace)
     * @param {string} sourceName - Name of minion to clone
     * @param {string} newName - Name for the cloned minion
     * @param {Object} options - Clone options
     * @param {boolean} options.workspace - Copy full workspace (default: false, just copies task)
     * @param {boolean} options.inbox - Include inbox messages if workspace is copied
     */
    clone(sourceName, newName, options = {}) {
        this._validateName(newName);
        const sourceDir = path.join(this.minionsDir, sourceName);
        const newDir = path.join(this.minionsDir, newName);

        if (!fs.existsSync(sourceDir)) {
            throw new Error(`Minion '${sourceName}' not found`);
        }

        if (fs.existsSync(newDir)) {
            throw new Error(`Minion '${newName}' already exists`);
        }

        const taskPath = path.join(sourceDir, 'TASK.md');
        if (!fs.existsSync(taskPath)) {
            throw new Error(`Source minion has no TASK.md`);
        }

        if (options.workspace) {
            // Full workspace copy
            this._copyDirRecursive(sourceDir, newDir);

            // Update metadata
            const metaPath = path.join(newDir, 'meta.json');
            if (fs.existsSync(metaPath)) {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                meta.name = newName;
                meta.clonedFrom = sourceName;
                meta.clonedAt = new Date().toISOString();
                meta.containerId = null;
                meta.status = 'pending';
                delete meta.taskStatus;
                fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
            }

            // Remove STATUS file (start fresh)
            const statusPath = path.join(newDir, 'STATUS');
            if (fs.existsSync(statusPath)) {
                fs.rmSync(statusPath);
            }

            // Clear output directory
            const outputDir = path.join(newDir, 'output');
            if (fs.existsSync(outputDir)) {
                fs.rmSync(outputDir, { recursive: true });
                fs.mkdirSync(outputDir, { mode: 0o777 });
            }

            // Optionally copy inbox
            if (options.inbox) {
                const sourceInbox = path.join(this.networkDir, sourceName);
                const newInbox = path.join(this.networkDir, newName);
                if (fs.existsSync(sourceInbox)) {
                    this._copyDirRecursive(sourceInbox, newInbox);
                }
            }

            return { 
                name: newName, 
                clonedFrom: sourceName, 
                mode: 'workspace',
                path: newDir
            };
        } else {
            // Task-only clone (fresh workspace)
            fs.mkdirSync(newDir, { recursive: true, mode: 0o777 });
            fs.mkdirSync(path.join(newDir, 'output'), { recursive: true, mode: 0o777 });
            
            // Copy task
            const task = fs.readFileSync(taskPath, 'utf8');
            fs.writeFileSync(path.join(newDir, 'TASK.md'), task, { mode: 0o666 });

            // Create new metadata
            const sourceMeta = fs.existsSync(path.join(sourceDir, 'meta.json'))
                ? JSON.parse(fs.readFileSync(path.join(sourceDir, 'meta.json'), 'utf8'))
                : {};
            
            const meta = {
                name: newName,
                createdAt: new Date().toISOString(),
                task: task.substring(0, 200),
                status: 'pending',
                containerId: null,
                clonedFrom: sourceName,
                clonedAt: new Date().toISOString()
            };
            fs.writeFileSync(path.join(newDir, 'meta.json'), JSON.stringify(meta, null, 2));

            return { 
                name: newName, 
                clonedFrom: sourceName, 
                mode: 'task-only',
                path: newDir
            };
        }
    }

    /**
     * Parse age string to milliseconds
     * Accepts: 7d, 24h, 30m (days, hours, minutes)
     */
    _parseAge(ageStr) {
        const match = ageStr.match(/^(\d+)(d|h|m)$/);
        if (!match) {
            throw new Error(`Invalid age format: ${ageStr}. Use: 7d, 24h, 30m`);
        }
        const num = parseInt(match[1], 10);
        const unit = match[2];
        const multipliers = { d: 86400000, h: 3600000, m: 60000 };
        return num * multipliers[unit];
    }

    /**
     * Prune completed minions older than a threshold
     * @param {Object} options - Prune options
     * @param {string} options.olderThan - Age threshold (e.g., '7d', '24h', '30m')
     * @param {boolean} options.all - Remove all completed regardless of age
     * @param {boolean} options.dryRun - Just report what would be deleted
     * @returns {Array} - List of pruned minion names
     */
    prune(options = {}) {
        const olderThan = options.olderThan || '7d';
        const ageMs = options.all ? 0 : this._parseAge(olderThan);
        const now = Date.now();
        const pruned = [];

        const minions = this.list();

        for (const minion of minions) {
            // Only prune COMPLETE or FAILED minions
            if (minion.taskStatus !== 'COMPLETE' && minion.taskStatus !== 'FAILED') {
                continue;
            }

            // Check age
            const createdAt = new Date(minion.createdAt).getTime();
            const ageOfMinion = now - createdAt;

            if (options.all || ageOfMinion >= ageMs) {
                const minionDir = path.join(this.minionsDir, minion.name);

                if (!options.dryRun) {
                    // Remove container if exists
                    try {
                        this._docker(`rm -f hive-${minion.name}`);
                    } catch {}

                    // Remove workspace directory
                    if (fs.existsSync(minionDir)) {
                        fs.rmSync(minionDir, { recursive: true });
                    }

                    // Remove network inbox if exists
                    const inboxDir = path.join(this.networkDir, minion.name);
                    if (fs.existsSync(inboxDir)) {
                        fs.rmSync(inboxDir, { recursive: true });
                    }
                }

                pruned.push({
                    name: minion.name,
                    status: minion.taskStatus,
                    createdAt: minion.createdAt,
                    age: this._formatAge(ageOfMinion)
                });
            }
        }

        return pruned;
    }

    /**
     * Format age in human readable format
     */
    _formatAge(ms) {
        const days = Math.floor(ms / 86400000);
        const hours = Math.floor((ms % 86400000) / 3600000);
        const minutes = Math.floor((ms % 3600000) / 60000);
        
        if (days > 0) return `${days}d ${hours}h`;
        if (hours > 0) return `${hours}h ${minutes}m`;
        return `${minutes}m`;
    }

    /**
     * Retry a completed/failed minion - kill old container, reset workspace, spawn fresh
     * @param {string} name - Name of the minion to retry
     * @param {Object} options - Spawn options (claudeToken, keepAlive, memory, cpus)
     * @returns {{ name, containerId, minionDir }}
     */
    retry(name, options = {}) {
        const minionDir = path.join(this.minionsDir, name);

        if (!fs.existsSync(minionDir)) {
            throw new Error(`Minion '${name}' not found`);
        }

        const taskPath = path.join(minionDir, 'TASK.md');
        if (!fs.existsSync(taskPath)) {
            throw new Error(`Minion '${name}' has no TASK.md`);
        }

        const task = fs.readFileSync(taskPath, 'utf8');
        const metaPath = path.join(minionDir, 'meta.json');
        const oldMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

        // Kill old container if present
        try {
            this._docker(`stop hive-${name}`);
            this._docker(`rm hive-${name}`);
        } catch {
            // Container might already be stopped/removed
        }

        // Clear STATUS file
        const statusPath = path.join(minionDir, 'STATUS');
        if (fs.existsSync(statusPath)) {
            fs.rmSync(statusPath);
        }

        // Clear output directory
        const outputDir = path.join(minionDir, 'output');
        if (fs.existsSync(outputDir)) {
            fs.rmSync(outputDir, { recursive: true });
        }
        fs.mkdirSync(outputDir, { recursive: true, mode: 0o777 });

        // Carry forward resource limits from old meta unless overridden
        const memory = options.memory || oldMeta.memory;
        const cpus = options.cpus || oldMeta.cpus;

        // Build image if needed
        if (!this.imageExists()) {
            const projectDir = path.dirname(__dirname);
            this.buildImage(path.join(projectDir, 'hive'));
        }

        // Environment variables
        const envVars = [];
        if (options.claudeToken) {
            envVars.push(`-e CLAUDE_CODE_OAUTH_TOKEN=${options.claudeToken}`);
        }
        if (options.keepAlive) {
            envVars.push('-e KEEP_ALIVE=true');
        }

        // Resource limits
        const resourceArgs = [];
        if (memory) {
            resourceArgs.push(`--memory=${memory}`);
        }
        if (cpus) {
            resourceArgs.push(`--cpus=${cpus}`);
        }

        // Start container
        const envStr = envVars.join(' ');
        const resourceStr = resourceArgs.join(' ');
        const containerId = this._docker(
            `run -d --name hive-${name} ${envStr} ${resourceStr} -v ${minionDir}:/home/minion/workspace ${IMAGE_NAME}`
        ).trim();

        // Write updated metadata
        const meta = {
            name,
            createdAt: new Date().toISOString(),
            task: task.substring(0, 200),
            status: 'running',
            containerId,
            retriedAt: new Date().toISOString(),
            retryOf: oldMeta.createdAt
        };
        if (memory) meta.memory = memory;
        if (cpus) meta.cpus = cpus;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

        return { name, containerId, minionDir };
    }

    /**
     * Rename a minion (preserves workspace, updates metadata)
     * @param {string} oldName - Current minion name
     * @param {string} newName - New minion name
     * @returns {{ oldName, newName, path }}
     */
    rename(oldName, newName) {
        this._validateName(newName);
        const oldDir = path.join(this.minionsDir, oldName);
        const newDir = path.join(this.minionsDir, newName);

        if (!fs.existsSync(oldDir)) {
            throw new Error(`Minion '${oldName}' not found`);
        }

        if (fs.existsSync(newDir)) {
            throw new Error(`Minion '${newName}' already exists`);
        }

        // Check if container is running
        const metaPath = path.join(oldDir, 'meta.json');
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

        if (meta.containerId) {
            try {
                const status = this._docker(`inspect -f '{{.State.Status}}' hive-${oldName}`).trim().replace(/'/g, '');
                if (status === 'running' || status === 'paused') {
                    throw new Error(`Cannot rename running minion. Stop it first: hive kill ${oldName}`);
                }
            } catch (e) {
                if (e.message.includes('Cannot rename')) {
                    throw e;
                }
                // Container doesn't exist, that's fine
            }
        }

        // Rename the directory
        fs.renameSync(oldDir, newDir);

        // Update metadata
        meta.name = newName;
        meta.renamedFrom = oldName;
        meta.renamedAt = new Date().toISOString();
        meta.containerId = null; // Clear old container reference
        fs.writeFileSync(path.join(newDir, 'meta.json'), JSON.stringify(meta, null, 2));

        // Rename network inbox if it exists
        const oldInbox = path.join(this.networkDir, oldName);
        const newInbox = path.join(this.networkDir, newName);
        if (fs.existsSync(oldInbox)) {
            fs.renameSync(oldInbox, newInbox);
        }

        return { oldName, newName, path: newDir };
    }

    /**
     * Search across all minion outputs and optionally container logs
     * @param {string} query - Search string
     * @param {Object} options - Search options
     * @param {boolean} options.caseSensitive - Exact case matching (default: false)
     * @param {number} options.limit - Max results (0 = unlimited)
     * @param {boolean} options.logs - Also search container logs
     * @returns {Array<{minion, source, line, text}>}
     */
    search(query, options = {}) {
        const caseSensitive = options.caseSensitive || false;
        const limit = options.limit || 0;
        const includeLogs = options.logs || false;
        const results = [];

        const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, caseSensitive ? 'g' : 'gi');

        if (!fs.existsSync(this.minionsDir)) return results;

        for (const name of fs.readdirSync(this.minionsDir)) {
            const minionDir = path.join(this.minionsDir, name);
            const metaPath = path.join(minionDir, 'meta.json');
            if (!fs.existsSync(metaPath)) continue;

            // Search output file
            const outputPath = path.join(minionDir, 'output', 'claude-output.log');
            if (fs.existsSync(outputPath)) {
                const lines = fs.readFileSync(outputPath, 'utf8').split('\n');
                for (let i = 0; i < lines.length; i++) {
                    regex.lastIndex = 0;
                    if (regex.test(lines[i])) {
                        results.push({
                            minion: name,
                            source: 'output',
                            line: i + 1,
                            text: lines[i]
                        });
                        if (limit > 0 && results.length >= limit) return results;
                    }
                }
            }

            // Search container logs if requested
            if (includeLogs) {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                if (meta.containerId) {
                    try {
                        const logs = this._docker(`logs hive-${name} 2>&1`);
                        const lines = logs.split('\n');
                        for (let i = 0; i < lines.length; i++) {
                            regex.lastIndex = 0;
                            if (regex.test(lines[i])) {
                                results.push({
                                    minion: name,
                                    source: 'logs',
                                    line: i + 1,
                                    text: lines[i]
                                });
                                if (limit > 0 && results.length >= limit) return results;
                            }
                        }
                    } catch {
                        // Container may be removed
                    }
                }
            }
        }

        return results;
    }

    /**
     * Generate a markdown report of all minions
     * @returns {string} - Markdown report
     */
    report() {
        const minions = this.list();
        const now = Date.now();
        const lines = [];

        lines.push('# Hive Report');
        lines.push('');
        lines.push(`Generated: ${new Date().toISOString()}`);
        lines.push('');

        if (minions.length === 0) {
            lines.push('No minions found.');
            return lines.join('\n');
        }

        // Summary table
        lines.push('## Minions');
        lines.push('');
        lines.push('| Name | Status | Task | Runtime | Exit Code |');
        lines.push('|------|--------|------|---------|-----------|');

        for (const m of minions) {
            const status = m.taskStatus || m.status || 'unknown';
            const task = (m.task || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').substring(0, 60);
            const runtime = this._formatAge(now - new Date(m.createdAt).getTime());

            // Get exit code from container if available
            let exitCode = '-';
            if (m.containerId) {
                try {
                    exitCode = this._docker(`inspect -f '{{.State.ExitCode}}' hive-${m.name}`).trim().replace(/'/g, '');
                    if (m.containerStatus === 'running') exitCode = '-';
                } catch {
                    exitCode = '-';
                }
            }

            lines.push(`| ${m.name} | ${status} | ${task} | ${runtime} | ${exitCode} |`);
        }

        // Per-minion output summaries
        lines.push('');
        lines.push('## Output Summaries');

        for (const m of minions) {
            lines.push('');
            lines.push(`### ${m.name}`);
            lines.push('');

            const outputPath = path.join(this.minionsDir, m.name, 'output', 'claude-output.log');
            if (fs.existsSync(outputPath)) {
                const output = fs.readFileSync(outputPath, 'utf8');
                if (output.trim()) {
                    const summary = output.substring(0, 500);
                    lines.push('```');
                    lines.push(summary);
                    if (output.length > 500) lines.push('... (truncated)');
                    lines.push('```');
                } else {
                    lines.push('_No output yet._');
                }
            } else {
                lines.push('_No output yet._');
            }
        }

        // Aggregate stats
        lines.push('');
        lines.push('## Stats');
        lines.push('');

        const byStatus = {};
        let running = 0;
        for (const m of minions) {
            const s = m.taskStatus || m.status || 'unknown';
            byStatus[s] = (byStatus[s] || 0) + 1;
            const cs = (m.containerStatus || '').replace(/'/g, '');
            if (cs === 'running') running++;
        }

        lines.push(`- **Total minions:** ${minions.length}`);
        lines.push(`- **Running:** ${running}`);
        for (const [status, count] of Object.entries(byStatus)) {
            lines.push(`- **${status}:** ${count}`);
        }

        const runtimes = minions.map(m => now - new Date(m.createdAt).getTime());
        if (runtimes.length > 0) {
            runtimes.sort((a, b) => a - b);
            const avg = runtimes.reduce((a, b) => a + b, 0) / runtimes.length;
            lines.push(`- **Avg runtime:** ${this._formatAge(Math.floor(avg))}`);
            lines.push(`- **Oldest:** ${this._formatAge(runtimes[runtimes.length - 1])}`);
            lines.push(`- **Newest:** ${this._formatAge(runtimes[0])}`);
        }

        lines.push('');
        return lines.join('\n');
    }

    /**
     * Get aggregate statistics across all minions
     * @returns {{ minions, resources, uptime, templates }}
     */
    aggregateStats() {
        const minions = this.list();
        const now = Date.now();

        // Count by status
        const running = [];
        const stopped = [];
        for (const m of minions) {
            const s = (m.containerStatus || m.status || '').replace(/^'+|'+$/g, '');
            if (s === 'running') {
                running.push(m);
            } else {
                stopped.push(m);
            }
        }

        const result = {
            minions: {
                running: running.length,
                stopped: stopped.length,
                total: minions.length
            },
            resources: {
                cpu: 0,
                memoryBytes: 0,
                memoryHuman: '0 B'
            },
            uptime: {
                oldest: null,
                newest: null,
                average: null
            },
            templates: 0
        };

        // Aggregate resource usage from running containers
        for (const m of running) {
            try {
                const statsOutput = this._docker(`stats hive-${m.name} --no-stream --format "{{json .}}"`);
                const s = JSON.parse(statsOutput.trim());

                // Parse CPU percentage (e.g., "45.50%")
                const cpuStr = (s.CPUPerc || '0%').replace('%', '');
                result.resources.cpu += parseFloat(cpuStr) || 0;

                // Parse memory usage (e.g., "50MiB / 1GiB" - take just the usage part)
                const memStr = (s.MemUsage || '0B / 0B').split('/')[0].trim();
                result.resources.memoryBytes += this._parseMemory(memStr);
            } catch {
                // Skip containers we can't get stats for
            }
        }

        result.resources.memoryHuman = this._humanSize(result.resources.memoryBytes);

        // Uptime stats from running minions
        if (running.length > 0) {
            const runtimes = running.map(m => now - new Date(m.createdAt).getTime());
            runtimes.sort((a, b) => a - b);

            result.uptime.oldest = this._formatAge(runtimes[runtimes.length - 1]);
            result.uptime.newest = this._formatAge(runtimes[0]);
            const avg = runtimes.reduce((a, b) => a + b, 0) / runtimes.length;
            result.uptime.average = this._formatAge(Math.floor(avg));
        }

        // Template count
        result.templates = this.templateList().length;

        return result;
    }

    /**
     * Parse a memory string (e.g., "50MiB", "1.2GiB", "500kB") to bytes
     */
    _parseMemory(str) {
        const match = str.match(/([\d.]+)\s*(B|KiB|MiB|GiB|kB|MB|GB)/);
        if (!match) return 0;
        const value = parseFloat(match[1]);
        const unit = match[2];
        const multipliers = {
            'B': 1,
            'KiB': 1024,
            'kB': 1000,
            'MiB': 1024 * 1024,
            'MB': 1000000,
            'GiB': 1024 * 1024 * 1024,
            'GB': 1000000000
        };
        return value * (multipliers[unit] || 1);
    }

    /**
     * Helper: recursively copy a directory
     */
    _copyDirRecursive(src, dest) {
        fs.mkdirSync(dest, { recursive: true });
        const entries = fs.readdirSync(src, { withFileTypes: true });
        
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            
            if (entry.isDirectory()) {
                this._copyDirRecursive(srcPath, destPath);
            } else {
                fs.copyFileSync(srcPath, destPath);
            }
        }
    }
}

module.exports = { Hive, HIVE_DIR, IMAGE_NAME };
