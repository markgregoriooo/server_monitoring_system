# ============================================================================
#  CSPC-ICTU Monitoring System — BACKEND image (API + pollers)
# ----------------------------------------------------------------------------
#  Build from the REPO ROOT (the context must include backend/):
#      docker build -t cspc-monitoring-backend .
#
#  Run — configuration comes from the environment, never from a baked-in file:
#      docker run -d --name cspc-backend -p 3001:3001 \
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

# Node 22 LTS. Several dependencies (google-auth-library 10, express-rate-limit 8,
# nodemailer 9) need Node 18+. `alpine` keeps the image small; the apk line below adds
# what it is missing.
FROM node:22-alpine

# ── ping ──────────────────────────────────────────────────────
# services/icmpPing.js runs the OS `ping`. Alpine's BusyBox ping refuses fractional
# timeouts:
#
#     $ ping -n -c 1 -W 0.5 127.0.0.1     # what pingArgs() emits below 1000 ms
#     ping: invalid number '0.5'          # BusyBox — fractional seconds refused
#
# so any PING_TIMEOUT_MS that is not a whole second would break every ping-only
# router. iputils-ping accepts it.
#
# tzdata: Alpine has no time zone data, so TZ below would otherwise stay UTC.
#
# mariadb-client: mariadb-dump, for the weekly system backup (Backups page). The backend
# dumps the `db` service over the compose network with its own DB_* credentials, so it
# never needs the Docker socket mounted (which would be root on the host).
RUN apk add --no-cache iputils-ping tzdata mariadb-client

ENV NODE_ENV=production \
    TZ=Asia/Manila \
    PORT=3001

WORKDIR /app

# ── Dependencies first, source second ───────────────────────────────────────
# Copying the package files first lets Docker cache the install layer until they
# change. `npm ci` installs exactly what package-lock.json lists, so two builds of the
# same commit give the same image. --omit=dev leaves out nodemon.
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# Only the backend. .dockerignore keeps the rest (frontend, agent, firmware,
# node_modules, any .env) out of the build context.
COPY backend/ ./

# ── Writable folders ──────────────────────────────────────────────────────────
# Three folders the app writes to, under BACKEND_ROOT (config/env.js), i.e. /app:
#   backups/   the on-site copy of every sample; must be a volume so it survives
#              the container
#   reports/   generated CSV/PDF files
#   branding/  uploaded letterhead logos
# Only these are chowned (`chown -R /app` would copy node_modules into a new layer,
# +58 MB). The code stays owned by root, so the app cannot modify it.
RUN mkdir -p backups reports branding && chown node:node backups reports branding

# Never root. Same rule as ops/systemd/cspc-monitoring.service: this process
# holds JWT_SECRET, the MikroTik encryption key and every SNMP community.
USER node

# Declared AFTER the chown so a bind mount inherits sane ownership.
VOLUME ["/app/backups", "/app/reports", "/app/branding"]

# Documentation only — publishing the port is `-p 3001:3001` at run time. The
# server binds 0.0.0.0 for the ESP32 and the Go agents (src/server.js).
EXPOSE 3001

# GET /api/policy/version is the one public route that needs no database, so it checks
# the process is serving HTTP without failing during a MySQL blip. start-period covers
# startup checks and the first poll.
# ${PORT:-3001}, not ${PORT}: compose's env_file overrides image ENV, and a blank
# `PORT=` in backend/.env would make the URL http://127.0.0.1:/api/... while the
# server still runs on 3001.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3001}/api/policy/version" || exit 1

# Exec form, so node is PID 1 and gets SIGTERM directly. The shutdown handler flushes
# the backup buffer (src/server.js); a shell wrapper would swallow the signal.
CMD ["node", "src/server.js"]
