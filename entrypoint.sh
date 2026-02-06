#!/bin/bash
# Hive Minion Entrypoint

set -e

TASK_FILE="/home/minion/workspace/TASK.md"
OUTPUT_DIR="/home/minion/workspace/output"
STATUS_FILE="/home/minion/workspace/STATUS"

mkdir -p "$OUTPUT_DIR"

echo "STARTING" > "$STATUS_FILE"
echo "[$(date)] Minion starting up..."

# Check for task
if [ ! -f "$TASK_FILE" ]; then
    echo "ERROR: No task file found at $TASK_FILE"
    echo "FAILED" > "$STATUS_FILE"
    exit 1
fi

echo "[$(date)] Task received:"
cat "$TASK_FILE"
echo ""

echo "WORKING" > "$STATUS_FILE"

# Run Claude Code with the task
cd /home/minion/workspace

# Execute Claude Code in non-interactive mode
claude --print "$(cat $TASK_FILE)" 2>&1 | tee "$OUTPUT_DIR/claude-output.log"

# Check if work was done
if [ -f "$OUTPUT_DIR/claude-output.log" ]; then
    echo "COMPLETE" > "$STATUS_FILE"
    echo "[$(date)] Minion task complete"
else
    echo "FAILED" > "$STATUS_FILE"
    echo "[$(date)] Minion task failed"
fi

# Keep container alive for output collection (optional)
if [ "$KEEP_ALIVE" = "true" ]; then
    echo "[$(date)] Keeping alive for inspection..."
    tail -f /dev/null
fi
