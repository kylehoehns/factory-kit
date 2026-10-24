# The factory's sandbox image for this repo: what an agent gets, and nothing else. Add your stack's tools.
# Deliberately no gh and no GitHub credentials: agents never talk to GitHub; the factory does that for them.
# Rebuild it with `npm run build-images` in factory-kit after changing it.
FROM ubuntu:24.04

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl jq ca-certificates unzip \
  && rm -rf /var/lib/apt/lists/*

# Match the host user's UID/GID so files in the bind-mounted worktree keep the right owner.
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN userdel -r ubuntu 2>/dev/null || true \
  && (getent group "$AGENT_GID" || groupadd -g "$AGENT_GID" agent) \
  && useradd -o -u "$AGENT_UID" -g "$AGENT_GID" -m -d /home/agent -s /bin/bash agent
USER ${AGENT_UID}:${AGENT_GID}

RUN curl -fsSL https://claude.ai/install.sh | bash -s 2.1.307
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent
# Sandcastle bind-mounts the git worktree at /home/agent/workspace and runs the agent there.
ENTRYPOINT ["sleep", "infinity"]
