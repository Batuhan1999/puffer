# Pinned to the Node the relay is developed on.
FROM node:24.15.0-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
RUN mkdir -p /data && chown node:node /data

ENV HOST=0.0.0.0 PORT=8080 PUFFER_STATE=/data/registry.json
EXPOSE 8080
# Starts as root only to hand the volume to the unprivileged node user (Fly mounts a new volume owned by root),
# then runs the relay as node.
CMD ["sh", "-c", "chown -R node:node /data && exec setpriv --reuid=node --regid=node --init-groups -- node --import tsx src/server.ts"]
