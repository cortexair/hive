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

        // Start container
        const envStr = envVars.join(' ');
        const containerId = this._docker(
            `run -d --name hive-${name} ${envStr} -v ${minionDir}:/home/minion/workspace ${IMAGE_NAME}`
        ).trim();

        // Update metadata
        meta.containerId = containerId;
        meta.status = 'running';
        fs.writeFileSync(path.join(minionDir, 'meta.json'), JSON.stringify(meta, null, 2));

        return { name, containerId, minionDir };
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
}

module.exports = { Hive, HIVE_DIR, IMAGE_NAME };
