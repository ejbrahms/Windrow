# The central process as a container — docs/design/deployment-boundary-decision.md.
#
# WHY CENTRAL AND NOT THE NODE. A node reads and watches the host's own hook config
# (~/.claude/settings.json — server/hookWatcher.js), scans the host's skill directories, and binds
# :4000 to 127.0.0.1 because that bind is what makes the agent token machine-local *by
# construction* (server/index.js). None of that survives a container boundary. Central has no host
# coupling at all: its state is Postgres plus a CA directory, which is exactly what a volume is for.
#
# BUILD CONTEXT IS THE REPO ROOT, not this directory:
#   docker compose -f server/central/docker-compose.yml build
# because central requires ../config, ../schema, ../enrollment and ../principals — the whole
# server/ tree, not the central/ subdirectory.

# ---- deps -------------------------------------------------------------------
# A builder stage purely because server/package.json carries better-sqlite3, which is a native
# module needing a toolchain. Central itself never loads it — central/policyStore.js is explicit
# that requiring the node's store "would pull better-sqlite3, the node's data directory and its
# whole app" — but `npm ci` builds every dependency regardless, so the toolchain has to exist
# somewhere. Keeping it in a discarded stage is what stops g++ shipping to production.
FROM node:22-bookworm-slim AS deps
WORKDIR /app/server
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/server

COPY --from=deps /app/server/node_modules ./node_modules
COPY server/ ./

# The data directory holds the enrollment CA (server/enrollment/ca.js: ca-key.pem, ca-cert.pem and
# the TLS server cert derived from them) and the bootstrap enrollment token. It is a VOLUME because
# that CA signs every node certificate in the fleet — losing it does not degrade anything, it
# orphans every enrolled node at once. Created and chowned here so the unprivileged user below can
# write it even on a fresh named volume.
RUN rm -rf /app/server/data /app/server/daemon \
  && mkdir -p /app/server/data \
  && chown -R node:node /app/server/data
VOLUME ["/app/server/data"]

USER node

# Only the mutual-TLS listener is exposed. The plaintext listener is bound to 127.0.0.1 by
# central/index.js and only exists when WINDROW_CENTRAL_ALLOW_INSECURE=1 — inside a container that
# loopback is the CONTAINER's loopback, so it cannot be published even by accident. That is what
# makes it safe to leave on here and use as the healthcheck target below, which is a property the
# host install does not have.
EXPOSE 5443

# `node -e` rather than curl: the slim image ships no curl, and Node 22 has global fetch. Hitting
# the container-local plaintext /health avoids presenting a client certificate to check liveness.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WINDROW_CENTRAL_PORT||5000)+'/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "central/index.js"]
