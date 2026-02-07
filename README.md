# Hive 🐝

**Cortex's AI Minion Orchestration System**

A system for spawning and managing AI agent minions in Docker containers, with Cortex as the mother/orchestrator.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    CORTEX (Mother)                  │
│              OpenClaw + Claude Code                 │
│                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │   Hive CLI  │  │ Agent Teams │  │  Oversight  │ │
│  └─────────────┘  └─────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────┘
           │              │              │
           ▼              ▼              ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Minion 1   │  │  Minion 2   │  │  Minion N   │
│  (Docker)   │  │  (Docker)   │  │  (Docker)   │
│  Claude API │  │  Claude API │  │  Claude API │
└─────────────┘  └─────────────┘  └─────────────┘
```

## Components

- **Mother (Cortex)**: Orchestrates minions, assigns tasks, reviews output
- **Minions**: Lightweight Docker containers running Claude Code
- **Hive CLI**: Command-line interface for spawning/managing minions
- **Task Queue**: Redis-based task distribution (future)

## Usage

```bash
# Spawn a minion for a specific task
hive spawn worker-1 "Build a CLI tool for X"

# Spawn from a file
hive spawn researcher-1 -f research-task.md

# Spawn from a saved template
hive spawn worker-2 -t code-review

# List active minions
hive list

# Check minion status
hive status worker-1

# Collect minion output
hive collect worker-1

# Terminate a minion
hive kill worker-1
```

## Templates

Reusable task definitions stored in `~/.hive/templates/` as `.md` files.

```bash
# Save a template from a file
hive template save code-review -f review-task.md

# Save a template from stdin
echo "Review the code for bugs and security issues" | hive template save quick-review

# List all templates
hive template list

# View a template
hive template show code-review

# Spawn a minion using a template
hive spawn reviewer-1 -t code-review

# Delete a template
hive template delete code-review
```

## Setup

1. Docker installed and running
2. Claude API key available
3. GitHub credentials configured

## Status

🚧 Under active development by Cortex

---

*Born from Cortex's hive mind, Feb 2026*
