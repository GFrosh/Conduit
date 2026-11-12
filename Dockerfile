# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# AI Processing Engine - multi-stage build.
#
# Stage 1 installs every dependency (build needs dev deps) and compiles.
# Stage 2 installs production dependencies only and copies the compiled output.
# The runtime image contains no TypeScript, no test suite and no source maps.
# ---------------------------------------------------------------------------

# ---- build -----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Manifests first: this layer is cached until dependencies actually change.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- production dependencies -----------------------------------------------
# Compiled separately so the lockfile resolves in the same environment as the
# build stage; the runtime stage then copies a finished tree.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- runtime ---------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Do not run as root: the process needs no write access to the image.
ENV HOST=0.0.0.0
ENV PORT=3000

# tini forwards SIGTERM to node so graceful shutdown actually fires. Without an
# init, node can be PID 1 and ignore the signal it needs to drain.
RUN apk add --no-cache tini

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Documentation travels with the image so an operator can read the contract
# from inside the container that serves it.
COPY docs ./docs

USER node
EXPOSE 3000

# Healthcheck hits liveness, not readiness: a service that is up but temporarily
# unready must not be restarted by the container runtime.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
