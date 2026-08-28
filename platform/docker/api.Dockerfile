FROM node:22.18.0-bookworm-slim AS build

RUN corepack enable
WORKDIR /build

COPY package.json ./package.json
COPY bin ./bin
COPY templates ./templates
COPY guidelines ./guidelines
COPY platform ./platform

RUN cd platform \
    && yarn install --immutable \
    && yarn build

FROM node:22.18.0-bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates docker.io git \
    && groupadd --gid 10001 ai-sdlc \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/ai-sdlc ai-sdlc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/ai-sdlc/platform
COPY --from=build /build /opt/ai-sdlc

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4100

EXPOSE 4100
USER 10001:10001
CMD ["node", "apps/api/dist/server.js"]
