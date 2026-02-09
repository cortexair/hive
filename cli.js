#!/usr/bin/env node
/**
 * Hive CLI - Cortex's Minion Control
 */

const { Hive, IMAGE_NAME } = require('./index.js');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const command = args[0];
const noSudo = args.includes('--no-sudo');

const hive = new Hive({ useSudo: !noSudo });

function usage() {
    console.log(`
🐝 Hive - Cortex's AI Minion Orchestration

Usage: hive <command> [options]

Commands:
  spawn <name> <task>          Spawn a new minion with a task
  spawn <name> -f <file>       Spawn with task from file
  spawn <name> -t <template>   Spawn with a saved template
  spawn <name> <task> --after <dep>  Spawn after dependency completes
  start <name>                 Start a waiting/pending minion
  list [--json]                List all minions (alias: ps)
  status <name> [--json]       Get minion status and output
  health                       Check system health (Docker, image, minions, disk)
  version                      Show Hive version
  stats                        Show aggregate hive statistics (--json for JSON)
  stats <name>                 Get resource usage for a single minion
  top [--interval N]           Live dashboard of all running minions
  logs <name> [--lines N] [-F] Get last N lines of logs (default 50), -F to follow
  wait <name> [--timeout S]    Wait for minion to complete (default: 300s)
  watch <name>                 Stream live logs from a minion
  exec <name> [command]        Run a command in a minion's container (default: /bin/bash)
  collect <name>               Collect minion output
  pause <name>                 Pause a running minion
  resume <name>                Resume a paused minion
  restart <name>               Restart a stopped minion
  kill <name>                  Terminate a minion
  cleanup                      Remove completed minions (containers only)
  prune [--older-than 7d]      Remove old completed minions (workspace + container)
  build                        Build the minion Docker image
  network send <from> <to> <msg>  Send a message between minions
  network inbox <name>           Read a minion's inbox
  network broadcast <from> <msg> Broadcast to all minions
  network clear <name>           Clear a minion's inbox
  export <name> [--output path]  Export minion workspace to tarball
  import <tarball> [--name n]    Import minion from tarball
  clone <source> <new-name>    Clone a minion (task-only by default)
  rename <old> <new>           Rename a minion (must be stopped)
  retry <name>                 Retry a completed/failed minion (fresh container, same task)
  search <query> [--logs]      Search across all minion outputs (and logs with --logs)
  watch-deps [--interval N]    Auto-start waiting minions when dependencies complete
  template save <name>         Save a template from stdin or --file
  template list                List all saved templates
  template show <name>         Display a template
  template delete <name>       Delete a template

Options:
  --keep-alive           Keep container running after task
  --after <name>         Wait for dependency minion to complete before starting
  --timeout <seconds>    Timeout for --after waiting (default: 0 = no timeout)
  --memory <limit>       Memory limit (e.g., 512m, 2g)
  --cpus <limit>         CPU limit (e.g., 0.5, 2)
  --no-sudo              Don't use sudo for Docker commands
  --older-than <age>     For prune: age threshold (7d, 24h, 30m)
  --all                  For prune: remove ALL completed (ignore age)
  --dry-run              For prune: show what would be deleted
  --logs                 Include container logs in export
  --inbox                Include inbox messages in export/clone
  --overwrite            Overwrite existing minion on import
  --workspace, -w        Clone full workspace (not just task)
  --limit <N>            For search: max number of results
  --case-sensitive       For search: exact case matching

Examples:
  hive spawn worker-1 "Build a hello world CLI in Node.js"
  hive spawn researcher-1 -f research-task.md --memory 1g --cpus 1
  hive spawn worker-2 -t code-review
  hive spawn step-2 "Analyze results" --after step-1
  hive start step-2
  hive template save code-review -f review-task.md
  echo "Review the PR" | hive template save quick-review
  hive export worker-1 --logs --inbox
  hive import worker-1-backup.tar.gz --name worker-restored
  hive clone worker-1 worker-1-retry
  hive clone worker-1 worker-1-v2 --workspace
  hive list
  hive status worker-1
  hive kill worker-1

Environment:
  HIVE_DIR               Directory for hive data (default: ~/.hive)
  CLAUDE_CODE_OAUTH_TOKEN  Claude API token for minions
`);
}

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
        } else if (args[i] === '-F') {
            result.follow = true;
            i++;
        } else if (args[i] === '-t' && args[i + 1]) {
            result.template = args[i + 1];
            i += 2;
        } else if (args[i] === '-w') {
            result.workspace = true;
            i++;
        } else {
            result._.push(args[i]);
            i++;
        }
    }
    return result;
}

async function main() {
    if (!command || command === 'help' || command === '--help') {
        usage();
        return;
    }

    const parsed = parseArgs(args.slice(1));

    try {
        switch (command) {
            case 'version': {
                const pkg = require('./package.json');
                if (parsed.json) {
                    console.log(JSON.stringify({ name: pkg.name, version: pkg.version }));
                } else {
                    console.log(`${pkg.name} v${pkg.version}`);
                }
                break;
            }

            case 'health': {
                const h = hive.health();

                console.log('\n🐝 Hive Health Check\n');
                console.log('─'.repeat(40));

                // Docker daemon
                if (h.docker.running) {
                    console.log('  Docker:    ✅ Running');
                } else {
                    console.log('  Docker:    ❌ Not running');
                    console.log('\n  Docker daemon is not available.');
                    console.log('  Start Docker and try again.');
                    break;
                }

                // Hive image
                if (h.image.exists) {
                    console.log(`  Image:     ✅ ${IMAGE_NAME} (${h.image.age} old)`);
                } else {
                    console.log(`  Image:     ⚠️  Not built (run: hive build)`);
                }

                // Minions
                console.log(`  Minions:   ${h.minions.running} running / ${h.minions.total} total`);
                if (Object.keys(h.minions.byStatus).length > 0) {
                    for (const [status, count] of Object.entries(h.minions.byStatus)) {
                        console.log(`             - ${status}: ${count}`);
                    }
                }

                // Disk usage
                if (h.disk.usage) {
                    console.log('  Disk:');
                    for (const entry of h.disk.usage) {
                        console.log(`             ${entry.Type}: ${entry.TotalCount || entry.Size || 'N/A'} (${entry.Reclaimable || '0B'} reclaimable)`);
                    }
                } else {
                    console.log('  Disk:      ⚠️  Unable to retrieve');
                }

                console.log('─'.repeat(40));
                console.log('');
                break;
            }

            case 'build': {
                const projectDir = path.dirname(__filename);
                hive.buildImage(projectDir);
                console.log('✅ Minion image built successfully');
                break;
            }

            case 'spawn': {
                const name = parsed._[0];
                let task = parsed._[1];

                if (!name) {
                    console.error('❌ Name required: hive spawn <name> <task>');
                    process.exit(1);
                }

                if (parsed.file) {
                    task = fs.readFileSync(parsed.file, 'utf8');
                } else if (parsed.template) {
                    task = hive.templateGet(parsed.template);
                }

                if (!task) {
                    console.error('❌ Task required: hive spawn <name> "task" or hive spawn <name> -f file.md or hive spawn <name> -t template');
                    process.exit(1);
                }

                const claudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
                if (!claudeToken) {
                    console.warn('⚠️  No CLAUDE_CODE_OAUTH_TOKEN set - minion may not be able to use Claude');
                }

                console.log(`🐝 Spawning minion: ${name}`);
                const spawnOptions = {
                    claudeToken,
                    keepAlive: parsed['keep-alive']
                };
                
                // Resource limits
                if (parsed.memory) {
                    spawnOptions.memory = parsed.memory;
                }
                if (parsed.cpus) {
                    spawnOptions.cpus = parsed.cpus;
                }
                
                if (parsed.after) {
                    // Dependency chaining: create in waiting state
                    const result = hive.spawnWaiting(name, task, parsed.after, spawnOptions);
                    console.log(`✅ Minion created (waiting)`);
                    console.log(`   Status:    waiting for '${parsed.after}' to complete`);
                    console.log(`   Workspace: ${result.minionDir}`);
                    if (parsed.memory) console.log(`   Memory:    ${parsed.memory}`);
                    if (parsed.cpus) console.log(`   CPUs:      ${parsed.cpus}`);
                    console.log(`\n   Start manually: hive start ${name}`);
                } else {
                    const result = hive.spawn(name, task, spawnOptions);
                    console.log(`✅ Minion spawned`);
                    console.log(`   Container: ${result.containerId.substring(0, 12)}`);
                    console.log(`   Workspace: ${result.minionDir}`);
                    if (parsed.memory) console.log(`   Memory:    ${parsed.memory}`);
                    if (parsed.cpus) console.log(`   CPUs:      ${parsed.cpus}`);
                }
                break;
            }

            case 'start': {
                const name = parsed._[0];
                if (!name) {
                    console.error('❌ Name required: hive start <name>');
                    process.exit(1);
                }

                const claudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
                if (!claudeToken) {
                    console.warn('⚠️  No CLAUDE_CODE_OAUTH_TOKEN set - minion may not be able to use Claude');
                }

                console.log(`🐝 Starting minion: ${name}`);
                const startOptions = {
                    claudeToken,
                    keepAlive: parsed['keep-alive']
                };
                if (parsed.memory) startOptions.memory = parsed.memory;
                if (parsed.cpus) startOptions.cpus = parsed.cpus;

                const result = hive.start(name, startOptions);
                console.log(`✅ Minion started`);
                console.log(`   Container: ${result.containerId.substring(0, 12)}`);
                console.log(`   Workspace: ${result.minionDir}`);
                break;
            }

            case 'ps':  // alias for list
            case 'list': {
                const minions = hive.list();
                
                if (parsed.json) {
                    console.log(JSON.stringify(minions, null, 2));
                    break;
                }
                
                if (minions.length === 0) {
                    console.log('No minions active');
                    return;
                }

                console.log('🐝 Active Minions:\n');
                for (const m of minions) {
                    const status = m.taskStatus || m.status || 'unknown';
                    const icon = status === 'COMPLETE' ? '✅' :
                                status === 'WORKING' ? '⚙️' :
                                status === 'FAILED' ? '❌' :
                                status === 'waiting' ? '⏸️' : '⏳';
                    console.log(`${icon} ${m.name}`);
                    console.log(`   Status: ${status}`);
                    if (m.dependsOn) {
                        console.log(`   After:  ${m.dependsOn}`);
                    }
                    console.log(`   Task: ${m.task?.substring(0, 60)}...`);
                    console.log(`   Created: ${m.createdAt}`);
                    console.log('');
                }
                break;
            }

            case 'status': {
                const name = parsed._[0];
                if (!name) {
                    console.error('❌ Name required: hive status <name>');
                    process.exit(1);
                }

                const status = hive.status(name);
                
                if (parsed.json) {
                    console.log(JSON.stringify(status, null, 2));
                    break;
                }
                
                console.log(`🐝 Minion: ${name}\n`);
                console.log(`Status: ${status.taskStatus || status.status}`);
                console.log(`Created: ${status.createdAt}`);
                console.log(`Container: ${status.containerId?.substring(0, 12)}`);
                
                if (status.output) {
                    console.log('\n--- Output ---');
                    console.log(status.output);
                }
                break;
            }

            case 'logs': {
                const name = parsed._[0];
                if (!name) {
                    console.error('❌ Name required: hive logs <name>');
                    process.exit(1);
                }

                const lines = parseInt(parsed.lines) || 50;
                const follow = parsed.follow || parsed.F;

                if (follow) {
                    console.log(`📜 Following logs for: ${name} (Ctrl+C to exit)`);
                    const proc = hive.logsFollow(name, lines);
                    proc.stdout.pipe(process.stdout);
                    proc.stderr.pipe(process.stderr);
                    
                    // Keep process alive until docker logs exits or Ctrl+C
                    await new Promise((resolve) => {
                        proc.on('close', resolve);
                        process.on('SIGINT', () => {
                            proc.kill();
                            resolve();
                        });
                    });
                } else {
                    const logs = hive.logs(name, lines);
                    console.log(logs);
                }
                break;
            }

            case 'wait': {
                const name = parsed._[0];
                if (!name) {
                    console.error('❌ Name required: hive wait <name>');
                    process.exit(1);
                }

                const timeoutSec = parseInt(parsed.timeout) || 300;
                console.log(`⏳ Waiting for minion: ${name} (timeout: ${timeoutSec}s)`);

                const result = await hive.wait(name, { timeoutMs: timeoutSec * 1000 });
                
                if (result.status === 'COMPLETE') {
                    console.log(`✅ Minion completed`);
                    if (result.output) {
                        console.log('\n--- Output ---');
                        console.log(result.output);
                    }
                } else if (result.status === 'FAILED') {
                    console.log(`❌ Minion failed`);
                    if (result.output) {
                        console.log('\n--- Output ---');
                        console.log(result.output);
                    }
                    process.exit(1);
                } else if (result.status === 'TIMEOUT') {
                    console.log(`⏱️  Timeout waiting for minion`);
                    process.exit(1);
                }
                break;
            }

            case 'collect': {
                const name = parsed._[0];
                if (!name) {
                    console.error('❌ Name required: hive collect <name>');
                    process.exit(1);
                }

                const result = hive.collect(name);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'kill': {
                const name = parsed._[0];
                if (!name) {
                    console.error('❌ Name required: hive kill <name>');
                    process.exit(1);
                }

                console.log(`🔪 Killing minion: ${name}`);
                hive.kill(name);
                console.log('✅ Minion terminated');
                break;
            }

            case 'cleanup': {
                console.log('🧹 Cleaning up completed minions...');
                const cleaned = hive.cleanup({ removeFiles: parsed['remove-files'] });
                if (cleaned.length === 0) {
                    console.log('Nothing to clean up');
                } else {
                    console.log(`Cleaned: ${cleaned.join(', ')}`);
                }
                break;
            }

            case 'prune': {
                const olderThan = parsed['older-than'] || '7d';
                const dryRun = parsed['dry-run'] || false;
                const all = parsed.all || false;

                if (dryRun) {
                    console.log('🔍 Dry run - showing what would be pruned:\n');
                } else {
                    console.log(`🗑️  Pruning completed minions${all ? '' : ` older than ${olderThan}`}...\n`);
                }

                const pruned = hive.prune({ olderThan, dryRun, all });

                if (pruned.length === 0) {
                    console.log('Nothing to prune');
                } else {
                    for (const m of pruned) {
                        const prefix = dryRun ? 'Would prune' : 'Pruned';
                        console.log(`  ${m.status === 'COMPLETE' ? '✅' : '❌'} ${m.name} (${m.status}, age: ${m.age})`);
                    }
                    console.log(`\n${dryRun ? 'Would prune' : 'Pruned'}: ${pruned.length} minion(s)`);
                }
                break;
            }

            case 'pause': {
                const name = parsed._[0];
                if (!name) {
                    console.error('❌ Name required: hive pause <name>');
                    process.exit(1);
                }

                console.log(`⏸️  Pausing minion: ${name}`);
                hive.pause(name);
                console.log('✅ Minion paused');
                break;
            }

            case 'resume': {
                const name = parsed._[0];
                if (!name) {
                    console.error('❌ Name required: hive resume <name>');
                    process.exit(1);
                }

                console.log(`▶️  Resuming minion: ${name}`);
                hive.resume(name);
                console.log('✅ Minion resumed');
                break;
            }

            case 'restart': {
                const name = parsed._[0];
                if (!name) {
                    console.error('❌ Name required: hive restart <name>');
                    process.exit(1);
                }

                console.log(`🔄 Restarting minion: ${name}`);
                hive.restart(name);
                console.log('✅ Minion restarted');
                break;
            }

            case 'stats': {
                const name = parsed._[0];
                if (name) {
                    // Per-minion stats
                    const stats = hive.stats(name);
                    console.log(`📊 Minion: ${name}\n`);
                    console.log(`CPU:     ${stats.CPUPerc || 'N/A'}`);
                    console.log(`Memory:  ${stats.MemUsage || 'N/A'} (${stats.MemPerc || 'N/A'})`);
                    console.log(`Net I/O: ${stats.NetIO || 'N/A'}`);
                    console.log(`Blk I/O: ${stats.BlockIO || 'N/A'}`);
                    console.log(`PIDs:    ${stats.PIDs || 'N/A'}`);
                } else {
                    // Aggregate stats
                    const s = hive.aggregateStats();

                    if (parsed.json) {
                        console.log(JSON.stringify(s, null, 2));
                        break;
                    }

                    console.log('\n🐝 Hive Statistics\n');
                    console.log(`Minions:   ${s.minions.running} running, ${s.minions.stopped} stopped, ${s.minions.total} total`);

                    const cpuDisplay = Math.round(s.resources.cpu * 10) / 10;
                    console.log(`Resources: ${cpuDisplay}% CPU, ${s.resources.memoryHuman} memory`);

                    if (s.uptime.oldest) {
                        console.log(`Uptime:    oldest ${s.uptime.oldest}, newest ${s.uptime.newest}, avg ${s.uptime.average}`);
                    } else {
                        console.log('Uptime:    no running minions');
                    }

                    console.log(`Templates: ${s.templates} saved`);
                    console.log('');
                }
                break;
            }

            case 'top': {
                const refreshMs = parseInt(parsed.interval) || 2000;
                
                console.log('🐝 Hive Top - Press Ctrl+C to exit\n');
                
                const render = () => {
                    const results = hive.topOnce();
                    
                    // Clear screen and move cursor to top
                    process.stdout.write('\x1b[2J\x1b[H');
                    
                    console.log('🐝 Hive Top - Live Dashboard');
                    console.log(`   Updated: ${new Date().toLocaleTimeString()}`);
                    console.log('');
                    
                    if (results.length === 0) {
                        console.log('   No running minions');
                        return;
                    }
                    
                    // Header
                    console.log('   ' + 'NAME'.padEnd(20) + 'STATUS'.padEnd(12) + 'CPU'.padEnd(10) + 'MEM'.padEnd(10) + 'UPTIME');
                    console.log('   ' + '-'.repeat(60));
                    
                    // Rows
                    for (const m of results) {
                        const icon = m.status === 'COMPLETE' ? '✅' : 
                                    m.status === 'WORKING' ? '⚙️ ' : 
                                    m.status === 'FAILED' ? '❌' : '⏳';
                        console.log(`   ${m.name.padEnd(20)}${icon} ${m.status.padEnd(8)}${m.cpu.padEnd(10)}${m.memPerc.padEnd(10)}${m.uptime}`);
                    }
                    
                    console.log('');
                    console.log('   Press Ctrl+C to exit');
                };
                
                // Initial render
                render();
                
                // Refresh loop
                const interval = setInterval(render, refreshMs);
                
                // Handle Ctrl+C gracefully
                process.on('SIGINT', () => {
                    clearInterval(interval);
                    console.log('\n\n👋 Exiting...');
                    process.exit(0);
                });
                
                // Keep running
                await new Promise(() => {});
                break;
            }

            case 'exec': {
                // Parse args manually to preserve command structure
                const execArgs = args.slice(1).filter(a => a !== '--no-sudo');
                const name = execArgs[0];
                if (!name) {
                    console.error('❌ Name required: hive exec <name> [command]');
                    process.exit(1);
                }

                const cmdArgs = execArgs.slice(1);
                const command = cmdArgs.length > 0 ? cmdArgs : ['/bin/bash'];

                // Verify minion exists
                try {
                    hive.status(name);
                } catch (err) {
                    console.error(`❌ ${err.message}`);
                    process.exit(1);
                }

                console.log(`🐝 Executing in minion: ${name}`);
                const exitCode = hive.exec(name, command);
                process.exit(exitCode || 0);
                break;
            }

            case 'watch': {
                const name = parsed._[0];
                if (!name) {
                    console.error('❌ Name required: hive watch <name>');
                    process.exit(1);
                }

                // Verify minion exists
                try {
                    hive.status(name);
                } catch (err) {
                    console.error(`❌ ${err.message}`);
                    process.exit(1);
                }

                console.log(`🔍 Watching minion: ${name}`);
                console.log('   Press Ctrl+C to stop\n');
                console.log('--- Live Logs ---\n');

                const { spawn } = require('child_process');
                const dockerCmd = hive.useSudo ? 'sudo' : 'docker';
                const dockerArgs = hive.useSudo 
                    ? ['docker', 'logs', '-f', `hive-${name}`]
                    : ['logs', '-f', `hive-${name}`];

                const proc = spawn(dockerCmd, dockerArgs, { stdio: 'inherit' });

                process.on('SIGINT', () => {
                    proc.kill();
                    console.log('\n\n👋 Stopped watching');
                    process.exit(0);
                });

                proc.on('exit', (code) => {
                    if (code !== 0 && code !== null) {
                        console.error(`\n❌ Container logs ended (code ${code})`);
                    }
                    process.exit(code || 0);
                });
                break;
            }

            case 'network': {
                const subcommand = parsed._[0];

                switch (subcommand) {
                    case 'send': {
                        const from = parsed._[1];
                        const to = parsed._[2];
                        const body = parsed._[3];
                        if (!from || !to || !body) {
                            console.error('❌ Usage: hive network send <from> <to> <message>');
                            process.exit(1);
                        }
                        const msg = hive.send(from, to, body);
                        console.log(`📨 Message sent: ${from} → ${to}`);
                        console.log(`   ID: ${msg.id}`);
                        break;
                    }

                    case 'inbox': {
                        const name = parsed._[1];
                        if (!name) {
                            console.error('❌ Name required: hive network inbox <name>');
                            process.exit(1);
                        }

                        const messages = hive.inbox(name);

                        if (parsed.json) {
                            console.log(JSON.stringify(messages, null, 2));
                            break;
                        }

                        if (messages.length === 0) {
                            console.log(`📭 No messages for ${name}`);
                            break;
                        }

                        console.log(`📬 Inbox for ${name}: ${messages.length} message(s)\n`);
                        for (const msg of messages) {
                            console.log(`  From: ${msg.from}  (${msg.timestamp})`);
                            console.log(`  ${msg.body}`);
                            console.log('');
                        }
                        break;
                    }

                    case 'broadcast': {
                        const from = parsed._[1];
                        const body = parsed._[2];
                        if (!from || !body) {
                            console.error('❌ Usage: hive network broadcast <from> <message>');
                            process.exit(1);
                        }
                        const sent = hive.broadcast(from, body);
                        console.log(`📢 Broadcast from ${from}: ${sent.length} recipient(s)`);
                        break;
                    }

                    case 'clear': {
                        const name = parsed._[1];
                        if (!name) {
                            console.error('❌ Name required: hive network clear <name>');
                            process.exit(1);
                        }
                        const result = hive.clearInbox(name);
                        console.log(`🧹 Cleared ${result.cleared} message(s) from ${name}'s inbox`);
                        break;
                    }

                    default:
                        console.error(`❌ Unknown network command: ${subcommand}`);
                        console.error('Usage: hive network <send|inbox|broadcast|clear>');
                        process.exit(1);
                }
                break;
            }

            case 'export': {
                const name = parsed._[0];
                if (!name) {
                    console.error('❌ Name required: hive export <name>');
                    process.exit(1);
                }

                const options = {
                    output: parsed.output || parsed.o,
                    includeLogs: parsed.logs || parsed['include-logs'],
                    includeInbox: parsed.inbox || parsed['include-inbox']
                };

                console.log(`📦 Exporting minion: ${name}`);
                const result = hive.export(name, options);
                console.log(`✅ Exported to: ${result.path}`);
                console.log(`   Size: ${result.sizeHuman}`);
                break;
            }

            case 'import': {
                const tarPath = parsed._[0];
                if (!tarPath) {
                    console.error('❌ Tarball required: hive import <path.tar.gz>');
                    process.exit(1);
                }

                const options = {
                    name: parsed.name || parsed.n,
                    overwrite: parsed.overwrite || parsed.force
                };

                console.log(`📥 Importing from: ${tarPath}`);
                const result = hive.import(tarPath, options);
                console.log(`✅ Imported minion: ${result.name}`);
                console.log(`   Path: ${result.path}`);
                break;
            }

            case 'template': {
                const subcommand = parsed._[0];

                switch (subcommand) {
                    case 'save': {
                        const name = parsed._[1];
                        if (!name) {
                            console.error('❌ Name required: hive template save <name>');
                            process.exit(1);
                        }

                        let content;
                        if (parsed.file) {
                            content = fs.readFileSync(parsed.file, 'utf8');
                        } else if (!process.stdin.isTTY) {
                            content = fs.readFileSync('/dev/stdin', 'utf8');
                        } else {
                            console.error('❌ Content required: pipe via stdin or use --file');
                            process.exit(1);
                        }

                        const result = hive.templateSave(name, content);
                        console.log(`📋 Template saved: ${name}`);
                        console.log(`   Path: ${result.path}`);
                        break;
                    }

                    case 'list': {
                        const templates = hive.templateList();

                        if (parsed.json) {
                            console.log(JSON.stringify(templates, null, 2));
                            break;
                        }

                        if (templates.length === 0) {
                            console.log('No templates saved');
                            break;
                        }

                        console.log('📋 Templates:\n');
                        for (const t of templates) {
                            console.log(`  ${t.name}`);
                            console.log(`   Size: ${t.size} bytes`);
                            console.log(`   Preview: ${t.preview.replace(/\n/g, ' ').substring(0, 60)}...`);
                            console.log('');
                        }
                        break;
                    }

                    case 'show': {
                        const name = parsed._[1];
                        if (!name) {
                            console.error('❌ Name required: hive template show <name>');
                            process.exit(1);
                        }

                        const content = hive.templateGet(name);
                        console.log(content);
                        break;
                    }

                    case 'delete': {
                        const name = parsed._[1];
                        if (!name) {
                            console.error('❌ Name required: hive template delete <name>');
                            process.exit(1);
                        }

                        hive.templateDelete(name);
                        console.log(`🗑️  Template deleted: ${name}`);
                        break;
                    }

                    default:
                        console.error(`❌ Unknown template command: ${subcommand}`);
                        console.error('Usage: hive template <save|list|show|delete>');
                        process.exit(1);
                }
                break;
            }

            case 'clone': {
                const sourceName = parsed._[0];
                const newName = parsed._[1];
                if (!sourceName || !newName) {
                    console.error('❌ Usage: hive clone <source> <new-name> [--workspace] [--inbox]');
                    process.exit(1);
                }

                const options = {
                    workspace: parsed.workspace || parsed.w,
                    inbox: parsed.inbox
                };

                console.log(`🧬 Cloning minion: ${sourceName} → ${newName}`);
                const result = hive.clone(sourceName, newName, options);
                console.log(`✅ Cloned minion: ${result.name}`);
                console.log(`   Mode: ${result.mode}`);
                console.log(`   Path: ${result.path}`);
                break;
            }

            case 'retry': {
                const name = parsed._[0];
                if (!name) {
                    console.error('❌ Name required: hive retry <name>');
                    process.exit(1);
                }

                const claudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
                const retryOptions = {
                    claudeToken,
                    keepAlive: parsed['keep-alive']
                };
                if (parsed.memory) retryOptions.memory = parsed.memory;
                if (parsed.cpus) retryOptions.cpus = parsed.cpus;

                console.log(`🔄 Retrying minion: ${name}`);
                const result = hive.retry(name, retryOptions);
                console.log(`✅ Minion retried`);
                console.log(`   Container: ${result.containerId.substring(0, 12)}`);
                console.log(`   Workspace: ${result.minionDir}`);
                break;
            }

            case 'rename': {
                const oldName = parsed._[0];
                const newName = parsed._[1];
                if (!oldName || !newName) {
                    console.error('❌ Usage: hive rename <old-name> <new-name>');
                    process.exit(1);
                }

                console.log(`✏️  Renaming minion: ${oldName} → ${newName}`);
                const result = hive.rename(oldName, newName);
                console.log(`✅ Minion renamed`);
                console.log(`   Path: ${result.path}`);
                break;
            }

            case 'search': {
                const query = parsed._[0];
                if (!query) {
                    console.error('❌ Query required: hive search <query> [--logs] [--limit N] [--case-sensitive]');
                    process.exit(1);
                }

                const searchOptions = {
                    logs: parsed.logs || false,
                    limit: parseInt(parsed.limit) || 0,
                    caseSensitive: parsed['case-sensitive'] || false
                };

                const results = hive.search(query, searchOptions);

                if (results.length === 0) {
                    console.log(`No matches found for "${query}"`);
                    break;
                }

                console.log(`🔍 Search results for "${query}":\n`);

                let currentMinion = null;
                for (const r of results) {
                    if (r.minion !== currentMinion) {
                        if (currentMinion !== null) console.log('');
                        console.log(`🐝 ${r.minion} (${r.source})`);
                        currentMinion = r.minion;
                    }
                    console.log(`   ${r.line}: ${r.text}`);
                }

                console.log(`\n${results.length} match(es) found`);
                break;
            }

            case 'watch-deps': {
                const intervalSec = parseInt(parsed.interval) || 5;
                const intervalMs = intervalSec * 1000;
                const claudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

                console.log(`🔗 Watching for dependency completions every ${intervalSec}s...`);
                console.log('   Press Ctrl+C to stop\n');

                process.on('SIGINT', () => {
                    if (hive._watchDepsStop) hive._watchDepsStop();
                    console.log('\n\n👋 Stopped watching dependencies');
                    process.exit(0);
                });

                await hive.watchDeps({
                    intervalMs,
                    claudeToken,
                    keepAlive: parsed['keep-alive'],
                    onStart(s) {
                        const ts = new Date().toLocaleTimeString();
                        console.log(`  [${ts}] ▶️  Started '${s.name}' (dependency '${s.dependsOn}' completed)`);
                    }
                });
                break;
            }

            default:
                console.error(`❌ Unknown command: ${command}`);
                usage();
                process.exit(1);
        }
    } catch (err) {
        console.error(`❌ Error: ${err.message}`);
        process.exit(1);
    }
}

main();
