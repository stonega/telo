FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS base
WORKDIR /app
COPY package.json bun.lock ./
FROM base AS dependencies
RUN bun install --frozen-lockfile --production
FROM base AS build
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
COPY sdk ./sdk
COPY services/code-truth/src/tool-catalog.ts ./services/code-truth/src/tool-catalog.ts
RUN bun run build
FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS runtime-base
ENV NODE_ENV=production PORT=3000
WORKDIR /app
FROM runtime-base AS runtime
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node package.json ./
COPY --chown=node:node skills ./skills
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]

# Optional CPU speech runtime; enable via --target app-transcription or compose.transcription.yaml.
FROM runtime-base AS transcription-runtime
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv libsndfile1 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/telo-asr
COPY src/transcription/requirements.txt /tmp/transcription-requirements.txt
RUN /opt/telo-asr/bin/pip install --no-cache-dir pip==25.3 \
    && /opt/telo-asr/bin/pip install --no-cache-dir torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cpu \
    && /opt/telo-asr/bin/pip install --no-cache-dir -r /tmp/transcription-requirements.txt \
    && rm /tmp/transcription-requirements.txt \
    && mkdir -p /var/lib/telo-models && chown node:node /var/lib/telo-models
ENV QWEN_ASR_PYTHON=/opt/telo-asr/bin/python QWEN_ASR_DIRECTORY=/var/lib/telo-models
FROM transcription-runtime AS app-transcription
COPY --from=runtime --chown=node:node /app /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]

# Pinned client only; the host's existing Docker daemon runs the task containers.
FROM docker:29-cli@sha256:b1805116a6a86cc591b5d5f60a910a0715cdcc9d18d866ad68b1457ead25c35c AS docker-client
# Pinned user-space toolchain managers for per-repository persistent /env volumes.
FROM ghcr.io/jdx/mise:2026.10.4 AS mise-bin
FROM ghcr.io/astral-sh/uv:0.8.3 AS uv-bin

# Pinned Antigravity CLI (agy) binary shared by the runner supervisor and task containers.
FROM runtime-base AS agy-bin
ARG AGY_RELEASE=1.5.15-5514532022517760
ARG AGY_ARCHIVE_BASE_URL=https://storage.googleapis.com/antigravity-public/antigravity-cli
ARG AGY_SHA512_AMD64=af3f0be58b8475940d79f9abea19e762ecc3d265ea9f56cff8dd805e27ba299b44a305a79504a7ffe6ebdfa29a294c56edc4caed1875990bfaf2fef1508ec8b0
ARG AGY_SHA512_ARM64=d64ad759781b50dfacfa7d9826c0ad469959d01bdf5a170acd4c83472eba31c677baf0052ac8ab48eef40f0d3f0e26057e752aabd24331c79f4c881d4b872125
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && case "$(uname -m)" in \
         x86_64|amd64) agy_path="linux-x64/cli_linux_x64.tar.gz"; agy_sha512="${AGY_SHA512_AMD64}" ;; \
         aarch64|arm64) agy_path="linux-arm/cli_linux_arm64.tar.gz"; agy_sha512="${AGY_SHA512_ARM64}" ;; \
         *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;; \
       esac \
    && curl -fsSL --connect-timeout 30 --max-time 300 --retry 3 "${AGY_ARCHIVE_BASE_URL}/${AGY_RELEASE}/${agy_path}" -o /tmp/agy.tar.gz \
    && printf '%s  /tmp/agy.tar.gz\n' "${agy_sha512}" | sha512sum -c - \
    && tar -xzf /tmp/agy.tar.gz -C /tmp antigravity \
    && install -m 0755 /tmp/antigravity /usr/local/bin/agy \
    && rm -f /tmp/agy.tar.gz /tmp/antigravity \
    && /usr/local/bin/agy --version

# Install supervisor tools before application files so code changes reuse this layer.
FROM runtime-base AS codex-supervisor-dependencies
COPY --from=docker-client /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && test -s /etc/ssl/certs/ca-certificates.crt \
    && npm install -g @openai/codex@0.155.1 \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*
COPY --from=agy-bin /usr/local/bin/agy /usr/local/bin/agy
# Trusted supervisor: only this service receives the selected engine socket.
FROM codex-supervisor-dependencies AS codex-supervisor
COPY --from=runtime --chown=node:node /app /app
HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "require('fs').accessSync('/etc/ssl/certs/ca-certificates.crt');fetch('http://127.0.0.1:3020/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/runner-server.js"]

# Reused for preparation, isolated implementation, and fresh PR publication.
FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS codex-job
ARG CODEX_VERSION=0.155.1
ARG OPEN_CODE_REVIEW_VERSION=1.12.12
RUN apt-get update && apt-get install -y --no-install-recommends \
      git bash ca-certificates curl xz-utils unzip build-essential pkg-config \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @openai/codex@${CODEX_VERSION} @alibaba-group/open-code-review@${OPEN_CODE_REVIEW_VERSION} \
    && npm cache clean --force
COPY --from=agy-bin /usr/local/bin/agy /usr/local/bin/agy
COPY --from=base /usr/local/bin/bun /usr/local/bin/bun
COPY --from=mise-bin /usr/local/bin/mise /usr/local/bin/mise
COPY --from=uv-bin /uv /uvx /usr/local/bin/
WORKDIR /opt/telo
COPY --from=build /app/dist/job.js ./job.js
COPY --from=dependencies /app/node_modules/zod ./node_modules/zod
# Browser dynamic-tool schemas share the application's explicit TypeBox dependency.
COPY --from=dependencies /app/node_modules/typebox ./node_modules/typebox
RUN mkdir /task /input /auth /env && chown node:node /task /auth /env
ENV HOME=/task/home
USER node
ENTRYPOINT ["node", "/opt/telo/job.js"]

# The trusted execd starts as root; the adapter launches every repository job as UID 1000.
FROM codex-job AS codex-opensandbox-job
USER root

# Trusted private supervisor has no application state or service credentials.
FROM runtime-base AS plugin-supervisor
ENV PORT=3030
COPY --from=docker-client /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build /app/dist/plugin-supervisor.js ./dist/plugin-supervisor.js
CMD ["node", "dist/plugin-supervisor.js"]

# Job contains only the protocol runtime and validators.
FROM runtime-base AS plugin-job
WORKDIR /opt/telo-plugin
COPY --from=build --chown=node:node /app/dist/plugin-job.mjs ./job.mjs
USER node
ENTRYPOINT ["node", "/opt/telo-plugin/job.mjs"]

# Preserve the ordinary app as the default build target.
FROM runtime AS app
