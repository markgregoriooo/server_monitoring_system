# ============================================================================
#  CSPC-ICTU Monitoring System — DASHBOARD image (static files + nginx)
# ----------------------------------------------------------------------------
#  Build from the REPO ROOT so the paths below resolve:
#      docker build -f frontend/Dockerfile -t cspc-monitoring-frontend \
#        --build-arg VITE_API_URL=https://monitoring.cspc-ictu.stream \
#        --build-arg VITE_GOOGLE_CLIENT_ID=<the OAuth client id> .
#
#  Normally you do not run this by hand — `docker compose up` passes both args.
#
#  Two stages, because the dashboard is not a program that runs. `npm run build`
#  turns the React source into a folder of plain HTML/JS/CSS, and after that
#  Node is dead weight: the second stage keeps only those files and a web server
#  to hand them out. That is why the finished image is ~50 MB instead of ~400.
# ============================================================================

# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /build

# Manifests first so the install layer is cached until dependencies change.
# NOT --omit=dev here: vite, typescript and tailwind are devDependencies and
# they are exactly what does the building.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./

# ⚠️ Vite inlines VITE_* at BUILD time — it finds and replaces the text in the
# source. There is no runtime environment inside a browser to read, so these
# cannot be supplied with `docker run -e` later. Change either one and the
# image must be REBUILT.
#
#   VITE_API_URL          where the browser sends /api and /socket.io traffic.
#                         Blank = auto-detect the page's own host on port 3000,
#                         which is right for a LAN install and WRONG behind the
#                         Cloudflare Tunnel (port 3000 is not published there) —
#                         set it to the public origin with no port.
#   VITE_GOOGLE_CLIENT_ID the OAuth client id. Public by design (it identifies
#                         the app to Google and ships in every page), unlike
#                         GOOGLE_CLIENT_SECRET, which stays in the backend.
ARG VITE_API_URL=""
ARG VITE_GOOGLE_CLIENT_ID=""
ENV VITE_API_URL=$VITE_API_URL \
    VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID

# ── Branding ────────────────────────────────────────────────────────────────
# Same build-time rule, and easy to forget: these live in frontend/.env during
# development, and .dockerignore keeps every .env OUT of the build context (it
# is the line that stops backend/.env being baked into an image). So a value
# not listed here simply is not set when Vite runs, and the app falls back to
# frontend/src/branding.ts — which is why the CSPC logo went missing and the
# sidebar showed the "CC" initials instead.
#
# The defaults below are the real CSPC values, so the image is correct even
# with an empty .env. VITE_LOGO_SRC points at a file in frontend/public/,
# which Vite copies into dist as-is.
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
# nginx is doing one small job here: handing out files. `serve` (deployment-
# guide §5.1) does the same job; nginx is the usual choice in a container
# because the image is tiny and it needs no Node runtime underneath.
FROM nginx:1.27-alpine

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /build/dist /usr/share/nginx/html

# The tunnel's catch-all points at localhost:8080, which compose maps to this.
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
