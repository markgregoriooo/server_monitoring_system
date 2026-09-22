# ============================================================================
#  CSPC-ICTU Monitoring System — BACKEND image (API + pollers)
# ----------------------------------------------------------------------------
#  Build from the REPO ROOT (the context must include backend/):
#      docker build -t cspc-monitoring-backend .
#
#  Run — configuration comes from the environment, never from a baked-in file:
#      docker run -d --name cspc-backend -p 3000:3000 \
#        --env-file backend/.env \
#        -v cspc-backups:/app/backups \
#        -v cspc-reports:/app/reports \
#        -v cspc-branding:/app/branding \
#        cspc-monitoring-backend
#
#  This image is the backend ONLY — it answers JSON and nothing else. The
#  dashboard is a separate image (frontend/Dockerfile), and MySQL + InfluxDB are
#  separate services again. `docker compose up` starts all four; this container
#  on its own is an API with nothing to talk to and no UI.
# ============================================================================

# Node 22 LTS. NOT node:17 — that line was never LTS and went end-of-life in
# June 2022, so it receives no security patches, and several dependencies here
# (google-auth-library 10, express-rate-limit 8, nodemailer 9) require Node 18+.
# `alpine` keeps the image small; the apk line below buys back the one thing it
# is missing.
FROM node:22-alpine

# ── ping, the real one ──────────────────────────────────────────────────────
# services/icmpPing.js SHELLS OUT to the OS `ping` (net-ping would need root —
# see the PING_TIMEOUT_MS notes in CLAUDE.md). Alpine ships BusyBox's ping,
# which is not quite the iputils ping the poller is written against:
#
#     $ ping -n -c 1 -W 0.5 127.0.0.1     # what pingArgs() emits below 1000 ms
#     ping: invalid number '0.5'          # BusyBox — fractional seconds refused
#
# The default PING_TIMEOUT_MS=2000 sends "-W 2" and survives by luck; set it to
# 1500 and every ping-only router goes dark with no error anyone can search for.
# iputils-ping accepts the fractional value, so install it and remove the trap.
#
# tzdata: Alpine has no zone database at all, so TZ below would silently stay
# UTC and every container log line would be 8 hours off the room it describes.
RUN apk add --no-cache iputils-ping tzdata

ENV NODE_ENV=production \
    TZ=Asia/Manila \
    PORT=3000

WORKDIR /app

# ── Dependencies first, source second ───────────────────────────────────────
# This ordering is the whole point of the two COPY steps: Docker caches each
# layer, and `COPY . .` before the install (the original) invalidated the cache
# on every source edit, re-downloading every package for a one-line change.
# Manifests change rarely, so the install layer is reused until they do.
#
# `npm ci` not `npm install`: ci installs exactly what package-lock.json pins
# and fails if the two disagree, which is what you want for an artifact handed
# to someone else — two builds of the same commit produce the same image.
# --omit=dev leaves out nodemon, which nothing in production runs.
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# Only the backend. Everything else in the repo — the frontend, the Go agent,
# the firmware, the audits — is not runtime input, and .dockerignore keeps it
# (plus node_modules and any .env) out of the build context entirely.
COPY backend/ ./

# ── Writable state ──────────────────────────────────────────────────────────
# Three directories the app writes to at runtime, resolved from BACKEND_ROOT
# (config/env.js), i.e. /app here:
#   backups/   the on-site NDJSON mirror of every sample — the copy that is
#              supposed to survive the database, so it must NOT live in the
#              container's writable layer, which dies with the container
#   reports/   generated CSV/PDF, referenced by rows in MySQL
#   branding/  uploaded letterhead logos
# Only these three are chowned. `chown -R /app` looks tidier and cost 58 MB in
# the first build of this image: chown rewrites every file's metadata, and a
# rewritten file is a new copy in a new layer, so it duplicated node_modules.
# Leaving the code owned by root is also the better end state — the app user can
# read its own source but cannot rewrite it.
RUN mkdir -p backups reports branding && chown node:node backups reports branding

# Never root. Same rule as ops/systemd/cspc-monitoring.service: this process
# holds JWT_SECRET, the MikroTik encryption key and every SNMP community.
USER node

# Declared AFTER the chown so a bind mount inherits sane ownership.
VOLUME ["/app/backups", "/app/reports", "/app/branding"]

# Documentation only — publishing the port is `-p 3000:3000` at run time. The
# server binds 0.0.0.0 for the ESP32 and the Go agents (src/server.js).
EXPOSE 3000

# GET /api/policy/version is the one public route that touches no database, so
# it answers "is the process serving HTTP?" without reporting the whole system
# unhealthy during a MySQL blip — the backend is designed to outlive its stores.
# start-period covers the boot-time config validation and the first poll tick.
# ${PORT:-3000}, not ${PORT}. The ENV above sets 3000, but compose's
# env_file OVERRIDES image ENV — so a blank `PORT=` line in backend/.env (which
# is what the template ships) makes PORT an empty string here. The URL then
# reads http://127.0.0.1:/api/... and every check fails, while the server is
# serving perfectly on 3000 because src/server.js does `Number(PORT) || 3000`.
# The result is a container that works and reports itself unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/api/policy/version" || exit 1

# Exec form, so node is PID 1 and receives SIGTERM directly. That matters here:
# the shutdown handler flushes the backup buffer synchronously (src/server.js),
# and a shell wrapper would swallow the signal and lose the un-flushed samples.
CMD ["node", "src/server.js"]
