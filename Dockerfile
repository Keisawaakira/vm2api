# Control plane. linux amd64 bins and wrap-cli ELFs ship in git. Slot guests run on the host engine.
FROM node:22-bookworm-slim AS web
WORKDIR /web
RUN corepack enable && corepack prepare pnpm@10.18.2 --activate
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
# The shared catalog resolves outside /web, just as ../src does in a checkout.
COPY src/lib/transport/offline-candidate-round.json /src/lib/transport/offline-candidate-round.json
RUN pnpm build

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates iptables iproute2 python3 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /opt/vm2api
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY VERSION CHANGELOG.md ./
COPY docker/kin-os ./docker/kin-os
COPY --from=web /web/dist ./web/dist
COPY bin/kin-kernel bin/kin-egress bin/kin-worker bin/kin-codex-kernel bin/kin-cookie-auth /opt/vm2api/image-bin/
COPY share/wrap-cli /opt/vm2api/image-wrap-cli
# Offline explicit crag probes can use this immutable asset without installing it into real slots.
COPY share/crag/kin-kernel /opt/vm2api/image-crag/kin-kernel
# Candidate CLIs are diagnostic assets only. No entrypoint/runtime installer copies them to production slots.
COPY share/offline-candidates /opt/vm2api/image-offline-candidates
# Owner-approved fixed wrap pair remains separate from original release updates.
COPY share/wrap-fixed /opt/vm2api/image-wrap-fixed
COPY share/cc-fixed /opt/vm2api/image-cc-fixed
COPY scripts/docker-entrypoint.sh /usr/local/bin/vm2api-entrypoint
RUN chmod 755 /usr/local/bin/vm2api-entrypoint /opt/vm2api/image-bin/* \
  && cp -a /opt/vm2api/src/config /opt/vm2api/image-config \
  && mkdir -p /opt/vm2api/vms /opt/vm2api/data /opt/vm2api/bin /opt/vm2api/share
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    KIN_PROJECT_ROOT=/opt/vm2api \
    KIN_DATA_DIR=/opt/vm2api/data \
    KIN_KERNEL_BIN=/opt/vm2api/bin/kin-kernel \
    KIN_EGRESS_BIN=/opt/vm2api/bin/kin-egress \
    KIN_WORKER_BIN=/opt/vm2api/bin/kin-worker \
    KIN_CODEX_KERNEL_BIN=/opt/vm2api/bin/kin-codex-kernel \
    KIN_COOKIE_AUTH_BIN=/opt/vm2api/bin/kin-cookie-auth
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/vm2api-entrypoint"]
