# The issuer's server: its own Holochain conductor (always on, holding the
# issuer's key) and the issuer service beside it, which alone talks to the
# conductor's admin interface (localhost only). Also runs the network's
# bootstrap/relay server (`kitsune2-bootstrap-srv`) as another service.
# Build from the repo root: docker build -f deploy/issuer/Dockerfile .
FROM node:24-slim

# Holochain's official Linux binaries, pinned and checked -- the same release
# and hashes as CI (.github/actions/holochain-bins/action.yml).
ARG RELEASE=holochain-0.7.1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* \
 && cd /usr/local/bin \
 && while read -r sha asset name; do \
      curl -fsSL "https://github.com/holochain/holochain/releases/download/${RELEASE}/${asset}" -o "$name" \
      && echo "$sha  $name" | sha256sum --check --strict \
      && chmod +x "$name"; \
    done <<'PINNED'
0c14700874349c8417c4bfebfe845e7ab036757442e4388e50dd622bb3c89974 holochain-x86_64-unknown-linux-gnu holochain
87c7a02556d47d950f0d4284bfdb4e37737b0bc98afe038955817793606d669a lair-keystore-x86_64-unknown-linux-gnu lair-keystore
f080b3ee4f3d4e37a2d790eb3df9722b5b1a1924d9d6c730c05c64859273a9d5 kitsune2-bootstrap-srv-x86_64-unknown-linux-gnu kitsune2-bootstrap-srv
PINNED

WORKDIR /app/issuer
COPY issuer/package.json issuer/package-lock.json ./
RUN npm ci --omit=dev || npm ci
COPY issuer/ ./
# The network's bundle, built with `npm run package` (in web/) -- the issuer
# installs exactly what everyone else runs.
COPY deploy/relay.happ /app/relay.happ
COPY deploy/issuer/start.sh /app/start.sh

ENV ISSUER_DATA_DIR=/var/lib/relay-issuer \
    CONDUCTOR_ADMIN_URL=ws://localhost:8870 \
    ISSUER_APP_ID=relay-issuer \
    DB_PATH=/var/lib/relay-issuer/issuer.db \
    PORT=8890
VOLUME /var/lib/relay-issuer
EXPOSE 8890
ENTRYPOINT ["/app/start.sh"]
CMD ["serve"]
