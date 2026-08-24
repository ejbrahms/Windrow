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

# The dashboard — docs/design/dashboard-placement.md item 4. Since that change the node serves no
# UI at all, so this bundle is the fleet's ONLY console rather than a second copy of one; the
# `express.static` mount is in central/routes.js, after every API route.
#
# COPIED, NOT BUILT HERE, and that is a deliberate refusal to add a stage. Building it in-image
# would mean installing the client's whole toolchain — a second `npm ci` over a dependency tree
# this process never loads — to produce 332 KB of static files that `npm run build` already makes
# on any machine that can check the repo out. The deps stage above exists under protest for exactly
# one native module; adding a second builder for an artifact with no native anything would be the
# same cost with none of the excuse.
#
# So `npm run build` is a prerequisite of `docker compose build`, and a missing bundle is not an
# image that fails to build — central/routes.js answers 503 with the command to run. An API that
# works and a dashboard that says why it is absent beats a build that stops the fleet's ingest
# going out over a frontend nobody asked for in this deployment.
COPY client/dist/ ./client-dist-staging/
RUN mkdir -p /app/client && mv /app/server/client-dist-staging /app/client/dist

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

# Two doors. :5443 is the mutual-TLS listener nodes ship to. :5599 is the dashboard proxy
# (central/dashboardProxy.js) — the browser's way in, since :5443 demands a client certificate no
# browser holds. The proxy forwards to the plaintext listener over the CONTAINER's loopback, which
# is what makes a certificate-less browser reachable; that plaintext listener itself stays bound to
# 127.0.0.1 and is still never published directly. The proxy grants full admin to whoever reaches
# it, so docker-compose.yml publishes :5599 to the host's 127.0.0.1 ONLY — the bind here is wide
# because Docker forwards published ports to the bridge interface, the exposure is not.
EXPOSE 5443 5599

# `node -e` rather than curl: the slim image ships no curl, and Node 22 has global fetch. Hitting
# the container-local plaintext /health avoids presenting a client certificate to check liveness.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WINDROW_CENTRAL_PORT||5000)+'/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "central/index.js"]
