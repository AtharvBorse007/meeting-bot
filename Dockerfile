# Lecture Recorder - the image deployed on the server (see docs/SETUP.md).
# Builds for both amd64 and arm64 (Oracle's free Ampere VMs): it uses Debian's Chromium package,
# which exists for both, instead of Google Chrome (amd64 only).

# ---------------------------------------------------------------- build
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p . && npm prune --omit=dev --no-audit --no-fund

# -------------------------------------------------------------- runtime
FROM node:22-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
# For networks whose proxy blocks plain-HTTP package downloads: build with
#   --build-arg APT_HTTPS=1 --secret id=ca,src=<a CA bundle .crt/.pem file>
# to fetch Debian packages over HTTPS (certificates are still checked against that bundle).
ARG APT_HTTPS=0
RUN --mount=type=secret,id=ca,required=false,mode=0444 \
    if [ "$APT_HTTPS" = "1" ]; then \
      sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources; \
      if [ -f /run/secrets/ca ]; then echo 'Acquire::https::CaInfo "/run/secrets/ca";' > /etc/apt/apt.conf.d/99build-ca; fi; \
    fi \
    && apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      xvfb \
      pulseaudio \
      ffmpeg \
      dumb-init \
      ca-certificates \
      fonts-liberation \
      fonts-noto-core \
      fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99build-ca

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY ui ./ui
COPY deploy/entrypoint.sh ./deploy/entrypoint.sh
RUN chmod +x deploy/entrypoint.sh \
    && mkdir -p /app/data /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix \
    && chown -R node:node /app/data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data \
    RECORDINGS_DIR=/app/data/recordings \
    CHROME_PATH=/usr/bin/chromium \
    UPLOADER_TYPE=local \
    DISPLAY=:99 \
    XDG_RUNTIME_DIR=/tmp/runtime-node

USER node
VOLUME /app/data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# --single-child: on "docker stop" (or when AWS stops a recorder task) only the app gets SIGTERM, so it
# can leave the meetings, save the recordings or hand over to a replacement while the virtual display and
# audio are still running. Set APP_ROLE=recorder to run one recorder worker instead of the dashboard.
ENTRYPOINT ["dumb-init", "--single-child", "--", "/app/deploy/entrypoint.sh"]
