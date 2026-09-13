# ---------------------------------------------------------------------------
# Launchpad.family production image.
#
# The server has NO runtime dependencies — node:http and node:sqlite are built
# in — so there is no install step and no package manager at runtime. That is
# why this is a single stage: there is nothing to build and nothing to prune.
#
# Node is pinned to the 22.22 line. node:sqlite is still flagged experimental,
# so its behaviour is allowed to change between minor versions; 22.22 is the
# line the test suite and the restart/WAL-recovery proof were run against.
# Bumping this is a deliberate act, not a rebuild side effect.
# ---------------------------------------------------------------------------
FROM node:22.22-alpine

# su-exec drops privileges in the CMD below. It is the only added package.
RUN apk add --no-cache su-exec

# web/ is not decoration: server/index.js resolves its static root as
# `../web/` relative to itself, so the two directories must keep this layout.
WORKDIR /app
COPY server/ ./server/
COPY web/ ./web/
RUN chown -R node:node /app

# Matches internal_port in fly.toml. HOST must be 0.0.0.0 — the app defaults to
# 127.0.0.1, which inside a container accepts nothing from outside it.
ENV PORT=8080 \
    HOST=0.0.0.0

EXPOSE 8080

# Starts as root ONLY to chown the volume, then immediately drops to `node`.
#
# The chown cannot be done at build time: Fly mounts the volume over /data at
# boot, and a fresh volume is owned by root:root, so the mount masks whatever
# ownership the image layer had. Without this the unprivileged process cannot
# create pads.db and the app dies on its first write. `exec` keeps the Node
# process as PID 1 so it receives Fly's signals directly.
CMD ["sh", "-c", "chown node:node /data && exec su-exec node node server/index.js"]
