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
        this.useSudo = options.useSudo !== false; // Default to sudo for Docker
        this._ensureDirs();
    }

    _ensureDirs() {
        if (!fs.existsSync(this.hiveDir)) fs.mkdirSync(this.hiveDir, { recursive: true });
        if (!fs.existsSync(this.minionsDir)) fs.mkdirSync(this.minionsDir, { recursive: true });
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
}

module.exports = { Hive, HIVE_DIR, IMAGE_NAME };
