# ============================================================================
#  CSPC-ICTU Monitoring System — DASHBOARD image (static files + nginx)
# ----------------------------------------------------------------------------
#  Build from the repo root so the paths below resolve:
#      docker build -f frontend/Dockerfile -t cspc-monitoring-frontend \
#        --build-arg VITE_API_URL=https://datacenter.cspc.edu.ph \
#        --build-arg VITE_GOOGLE_CLIENT_ID=<the OAuth client id> .
#
#  Normally `docker compose up` passes both args.
#
#  Two stages: `npm run build` turns the React source into plain HTML/JS/CSS, and
#  the second stage keeps only those files and nginx (~50 MB instead of ~400).
# ============================================================================

# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /build

# Package files first so the install layer is cached. No --omit=dev: vite,
# typescript and tailwind are devDependencies and do the building.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./

# Vite replaces VITE_* in the source at build time; a browser has no runtime
# environment, so these cannot be set later with `docker run -e`. Change either one and
# rebuild.
#
#   VITE_API_URL          where the browser sends /api and /socket.io.
#                         Blank = the page's own host on port 3001 (right for a LAN
#                         install, wrong behind a proxy, where it must be the public
#                         address with no port).
#   VITE_GOOGLE_CLIENT_ID the OAuth client id. Public (it is in every page), unlike
#                         GOOGLE_CLIENT_SECRET, which stays in the backend.
ARG VITE_API_URL=""
ARG VITE_GOOGLE_CLIENT_ID=""
ENV VITE_API_URL=$VITE_API_URL \
    VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID

# ── Branding ────────────────────────────────────────────────────────────────
# Also build-time. In development these come from frontend/.env, but .dockerignore
# keeps every .env out of the build, so they are passed here; otherwise the app falls
# back to frontend/src/branding.ts. The defaults are the real CSPC values.
# VITE_LOGO_SRC is a file in frontend/public/, copied into dist as is.
ARG VITE_APP_NAME="CSPC-ICTU"
ARG VITE_APP_FULL_NAME="Camarines Sur Polytechnic Colleges – Information and Communications Technology Unit"
ARG VITE_APP_SUBTITLE="MONITORING"
ARG VITE_APP_TAGLINE="SERVER INFRASTRUCTURE MONITORING SYSTEM"
ARG VITE_LOGO_TEXT="CC"
ARG VITE_LOGO_SRC="/logo-128.png"
ENV VITE_APP_NAME=$VITE_APP_NAME \
    VITE_APP_FULL_NAME=$VITE_APP_FULL_NAME \
    VITE_APP_SUBTITLE=$VITE_APP_SUBTITLE \
    VITE_APP_TAGLINE=$VITE_APP_TAGLINE \
    VITE_LOGO_TEXT=$VITE_LOGO_TEXT \
    VITE_LOGO_SRC=$VITE_LOGO_SRC

RUN npm run build

# ── Stage 2: serve ──────────────────────────────────────────────────────────
# nginx only serves the static files; small image, no Node needed.
FROM nginx:1.27-alpine

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /build/dist /usr/share/nginx/html

# The tunnel's catch-all points at localhost:8081, which compose maps to this.
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
