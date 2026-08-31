FROM node:22.18.0-bookworm-slim

ARG CODEX_VERSION=0.144.1

LABEL com.ai-sdlc.worker="true"

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force \
    && groupadd --gid 10001 worker \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/worker worker \
    && rm -rf /var/lib/apt/lists/*

ENV HOME=/home/worker \
    CODEX_HOME=/home/worker/.codex \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_OPTIONAL_LOCKS=0 \
    GIT_TERMINAL_PROMPT=0 \
    GIT_LFS_SKIP_SMUDGE=1 \
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=safe.directory \
    GIT_CONFIG_VALUE_0=/workspace

WORKDIR /home/worker
USER 10001:10001

ENTRYPOINT []
CMD ["codex", "--version"]
