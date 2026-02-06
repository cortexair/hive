# Hive Minion - Lightweight Claude Code Runner
# Multi-stage build for optimized image size and security

# Stage 1: Base image with system dependencies
FROM node:22-slim AS base

# Install security updates and essential tools
RUN apt-get update && apt-get upgrade -y && \
    apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Stage 2: Dependencies installation
FROM base AS dependencies

# Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code && \
    npm cache clean --force

# Stage 3: Final runtime image
FROM base AS runtime

# Copy Claude Code from dependencies stage
COPY --from=dependencies /usr/local/lib/node_modules/@anthropic-ai/claude-code /usr/local/lib/node_modules/@anthropic-ai/claude-code
COPY --from=dependencies /usr/local/bin/claude /usr/local/bin/claude

# Security: Create non-root user with minimal privileges
RUN useradd -m -s /bin/bash -u 1000 minion && \
    # Lock the account password
    passwd -l minion

# Set up directory structure with proper permissions
WORKDIR /home/minion
RUN mkdir -p workspace .claude logs && \
    chown -R minion:minion /home/minion

# Switch to non-root user
USER minion

# Claude Code settings for autonomous operation
RUN echo '{"permissions":{"allow":["Bash(*)","Read(*)","Write(*)","Edit(*)"],"deny":[]},"autoApprove":true}' > .claude/settings.json

# Copy entrypoint script with proper permissions
COPY --chown=minion:minion entrypoint.sh /home/minion/entrypoint.sh
RUN chmod +x /home/minion/entrypoint.sh

# Health check to verify container is responding
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD [ -f /home/minion/workspace/STATUS ] || exit 1

# Labels for metadata and maintainability
LABEL org.opencontainers.image.title="Hive Minion" \
      org.opencontainers.image.description="AI Minion worker for Hive orchestration system" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.authors="Cortex <cortexair@proton.me>" \
      org.opencontainers.image.source="https://github.com/cortexair/hive.git"

# Security: Run as non-root, read-only root filesystem compatible
# Note: workspace volume must be writable
VOLUME ["/home/minion/workspace", "/home/minion/logs"]

# Environment variables with defaults
ENV KEEP_ALIVE=false \
    NODE_ENV=production \
    NPM_CONFIG_LOGLEVEL=warn

# Expose no ports (security: minimal attack surface)
# Communication happens via shared volumes

ENTRYPOINT ["/home/minion/entrypoint.sh"]
