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

# ---------------------------------------------------------------------------
# runtime — nitro's node-server output is self-contained: `.output/server`
# ships its own package.json and node_modules (traced, including the native
# node-pty and BAML binaries), so nothing is installed here.
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

EXPOSE 3444

# Liveness only — see src/routes/api/health.ts for why it probes nothing else.
# `node -e` rather than curl/wget: neither is in the slim base, and node 22 has
# a global fetch.
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3444)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", ".output/server/index.mjs"]
