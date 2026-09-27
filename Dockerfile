# Node 24 for `node:sqlite`, which is what the database layer uses — there is
# no native module to build here, and it should stay that way.
FROM docker.io/library/node:24-slim AS build
WORKDIR /app

# Manifests first, so a change to source does not re-resolve the dependency tree.
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev


FROM docker.io/library/node:24-slim
ENV NODE_ENV=production
WORKDIR /app

# tini reaps zombies: the server spawns nothing in this configuration, but
# PID 1 without a reaper is a trap worth staying out of.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist

# db.ts resolves its directory relative to the compiled server, so this is
# where the database and photos land. Mount it.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME /app/data

# What this build is, for /api/version. The repo's .git is deliberately not in
# the build context, so the commit has to be handed in.
ARG GIT_SHA=""
ARG BUILD_TIME=""
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME

USER node
EXPOSE 3003
ENV API_PORT=3003

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/index.js"]
