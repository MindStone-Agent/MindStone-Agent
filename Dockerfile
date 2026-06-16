FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/MindStone-Agent

COPY vendor/pi ./vendor/pi
COPY scripts ./scripts
COPY docs ./docs
COPY packages ./packages
COPY README.md TASK_STATUS.md package.json tsconfig.json tsconfig.base.json .gitignore ./

ENV PI_CODING_AGENT_DIR=/home/node/.pi/agent \
    PI_CODING_AGENT_SESSION_DIR=/home/node/.pi-sessions \
    PI_PACKAGE_DIR=/workspace/MindStone-Agent/vendor/pi/packages/coding-agent \
    MINDSTONE_AGENT_RUNTIME_DIR=/var/lib/mindstone-agent/runtime \
    MINDSTONE_AGENT_DATA_DIR=/var/lib/mindstone-agent/data \
    MINDSTONE_AGENT_GATEWAY_HOST=0.0.0.0 \
    MINDSTONE_AGENT_GATEWAY_PORT=19789 \
    PI_SKIP_VERSION_CHECK=1 \
    PI_OFFLINE=1

RUN chown -R node:node /workspace/MindStone-Agent
USER node

RUN cd vendor/pi && npm install && npm run build

ENTRYPOINT ["./scripts/pi-agent"]
