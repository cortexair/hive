#!/usr/bin/env node
/**
 * Hive CLI - Cortex's Minion Control
 */

const { Hive } = require('./index.js');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const command = args[0];

const hive = new Hive();

function usage() {
    console.log(`
🐝 Hive - Cortex's AI Minion Orchestration

Usage: hive <command> [options]

Commands:
  spawn <name> <task>     Spawn a new minion with a task
  spawn <name> -f <file>  Spawn with task from file
  list                    List all minions
  status <name>           Get minion status and output
  watch <name>            Stream live logs from a minion
  collect <name>          Collect minion output
  kill <name>             Terminate a minion
  cleanup                 Remove completed minions
  build                   Build the minion Docker image

Options:
  --keep-alive           Keep container running after task
  --no-sudo              Don't use sudo for Docker commands

Examples:
  hive spawn worker-1 "Build a hello world CLI in Node.js"
  hive spawn researcher-1 -f research-task.md
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
                }

                if (!task) {
                    console.error('❌ Task required: hive spawn <name> "task" or hive spawn <name> -f file.md');
                    process.exit(1);
                }

                const claudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
                if (!claudeToken) {
                    console.warn('⚠️  No CLAUDE_CODE_OAUTH_TOKEN set - minion may not be able to use Claude');
                }

                console.log(`🐝 Spawning minion: ${name}`);
                const result = hive.spawn(name, task, {
                    claudeToken,
                    keepAlive: parsed['keep-alive']
                });
                console.log(`✅ Minion spawned`);
                console.log(`   Container: ${result.containerId.substring(0, 12)}`);
                console.log(`   Workspace: ${result.minionDir}`);
                break;
            }

            case 'list': {
                const minions = hive.list();
                if (minions.length === 0) {
                    console.log('No minions active');
                    return;
                }

                console.log('🐝 Active Minions:\n');
                for (const m of minions) {
                    const status = m.taskStatus || m.status || 'unknown';
                    const icon = status === 'COMPLETE' ? '✅' : 
                                status === 'WORKING' ? '⚙️' : 
                                status === 'FAILED' ? '❌' : '⏳';
                    console.log(`${icon} ${m.name}`);
                    console.log(`   Status: ${status}`);
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
