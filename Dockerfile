# Hive Minion - Lightweight Claude Code Runner
FROM node:22-slim

# Install essential tools
RUN apt-get update && apt-get install -y \
    git \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code

# Create minion user
RUN useradd -m -s /bin/bash minion
USER minion
WORKDIR /home/minion

# Create workspace
RUN mkdir -p workspace .claude

# Claude Code settings for autonomous operation
RUN echo '{"permissions":{"allow":["Bash(*)","Read(*)","Write(*)","Edit(*)"],"deny":[]},"autoApprove":true}' > .claude/settings.json

# Entry point script
COPY --chown=minion:minion entrypoint.sh /home/minion/entrypoint.sh
RUN chmod +x /home/minion/entrypoint.sh

ENTRYPOINT ["/home/minion/entrypoint.sh"]
