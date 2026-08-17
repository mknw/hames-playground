# syntax=docker/dockerfile:1
#
# The SolidStart app as a compose service (#197). Deployment/parity only — the
# native `pnpm dev` loop is untouched and remains the way to develop.
#
#   docker compose build app && docker compose up -d app
#
# Build context is `app/` (see ../docker-compose.yaml); nothing outside it is
# needed, since baml_src/ lives here too.

ARG NODE_VERSION=22-bookworm-slim
ARG PNPM_VERSION=10.28.1
ARG DOCKER_CLI_VERSION=28-cli

# Named stage purely so the CLI version can stay an ARG: `COPY --from=` does
# not expand variables, but `FROM` does.
FROM docker:${DOCKER_CLI_VERSION} AS docker-cli

# ---------------------------------------------------------------------------
# deps — full dependency tree (dev deps included; vinxi/unocss/baml-cli are all
# devDependencies and the build needs them).
#
# node-pty is compiled from source (`onlyBuiltDependencies`), so this stage
# carries a toolchain the runtime stage never sees. The BAML native addon and
# node-pty are both per-arch, which is why app/node_modules is .dockerignore'd:
# a host-built tree copied in here would be the wrong platform.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
ARG PNPM_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build — regenerate the BAML client, then build the server.
#
# `pnpm build` is `pnpm baml-generate & vinxi build`: the `&` backgrounds the
# generate step, which is a race the dev loop tolerates because baml_client/ is
# usually already on disk. Here it never is (generated + gitignored), so the two
# run sequentially and in order — a build that raced would compile against a
# missing or half-written client.
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .
RUN pnpm baml-generate \
 && pnpm exec vinxi build

# Nitro traces the `require`/`import` graph it can statically see, which is not
# enough for two packages — and it fails silently, leaving an image that boots
# and serves /api/health while the first use of either throws:
#
#   * node-pty         — lib/index.js loads build/Release/pty.node by path, so
#                        only lib/ + package.json are traced and
#                        `require('node-pty')` throws.
#   * @boundaryml/baml — the per-arch baml-<platform> package lands but the
#                        entry index.js does not, so the first BAML call dies
#                        with "Cannot find module .../baml/index.js".
#
# So stage both packages COMPLETE for the runtime stage to overlay. pnpm's
# node_modules/<pkg> are symlinks into .pnpm/<pkg>@<ver>/node_modules/<pkg>, so
# resolve them first and dereference while copying (`cp -RL`) — copying the
# link itself would leave a dangling one. The baml-<platform> package is a
# sibling of baml inside .pnpm, so the whole scope directory is staged to keep
# that resolution working. Nothing here names an architecture: the packages
# come from this image's own install, and the runtime stage is the same arch.
#
# node-pty's tarball also carries ~58MB of darwin/win32 prebuilds that no linux
# runtime can reach (lib/utils.js looks in build/Release, build/Debug, then
# prebuilds/linux-<arch> only), so they are dropped rather than shipped. The
# rest of the package stays whole: it is ~1MB, and an allow-list would be one
# more thing to keep in step with upstream.
RUN set -eux; \
    mkdir -p /staging/@boundaryml; \
    cp -RL "$(readlink -f node_modules/node-pty)" /staging/node-pty; \
    cp -RL "$(dirname "$(readlink -f node_modules/@boundaryml/baml)")"/. /staging/@boundaryml/; \
    rm -rf /staging/node-pty/prebuilds/darwin-* /staging/node-pty/prebuilds/win32-*; \
    test -f /staging/node-pty/build/Release/pty.node; \
    test -f /staging/@boundaryml/baml/index.js; \
    test -f /staging/@boundaryml/baml/browser.js; \
    ls /staging/@boundaryml | grep -q '^baml-'

# ---------------------------------------------------------------------------
# runtime — nitro's node-server output carries its own package.json and
# node_modules, so nothing is installed here; the natives its tracer missed are
# overlaid from the build stage's staging dir (see above).
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime

# The compute sandbox shells out to the docker CLI (`docker-backend.server.ts`)
# and the Shell tab drives it over `docker exec`. With the host socket mounted
# (see the compose service) sandbox containers are siblings on the host, not
# children of this one — which is why the sandbox `docker run` calls carry no
# bind mounts and work unchanged from in here. Without the socket the CLI is
# inert and only the sandbox agents fail, exactly as on a host without docker.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

# There is deliberately no `USER node`: the socket mount is already
# root-equivalent on the host, so an unprivileged in-image user would buy no
# isolation while losing access to /var/run/docker.sock (whose owning gid varies
# per host and per VM). If you do not need the compute sandbox, drop the socket
# mount from the compose service and add `USER node` here — they go together.

ENV NODE_ENV=production \
    PORT=3444 \
    HOST=0.0.0.0

WORKDIR /app
COPY --from=build /app/.output ./.output
COPY --from=build /staging/ ./.output/server/node_modules/

EXPOSE 3444

# Liveness only — see src/routes/api/health.ts for why it probes nothing else.
# `node -e` rather than curl/wget: neither is in the slim base, and node 22 has
# a global fetch.
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3444)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", ".output/server/index.mjs"]
