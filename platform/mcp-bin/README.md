# Operator-installed Work Item adapters

Cloud Compose mounts this directory read-only at `/opt/ai-sdlc/mcp-bin` in the API container.

Keep the repository default empty. An operator may either place a fixed-version executable here or set `AI_SDLC_MCP_BIN_ROOT` to a dedicated absolute host directory. Adapter commands and arguments remain server-owned through `AI_SDLC_WORK_ITEM_MCP_ADAPTERS`; the browser never chooses them.

For a JavaScript bridge, use the API image's fixed Node executable as `command` and the mounted script as the first argument, for example `/usr/local/bin/node /opt/ai-sdlc/mcp-bin/linear-bridge.mjs`.
