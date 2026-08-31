FROM node:22.18.0-bookworm-slim AS build

RUN corepack enable
WORKDIR /build/platform
COPY platform ./
RUN yarn install --immutable \
    && yarn workspace @ai-sdlc/web build

FROM nginx:1.27.5-alpine
COPY platform/docker/nginx-cloud.conf /etc/nginx/conf.d/default.conf
COPY --from=build /build/platform/apps/web/dist /usr/share/nginx/html

EXPOSE 8080
