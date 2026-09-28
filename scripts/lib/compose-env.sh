# shellcheck shell=bash
# Sourced by the Neo4j helper scripts. The laptop stack's database passwords
# have ONE source — the repo-root `.env` docker-compose.yaml reads — and this is
# how a script outside Compose reads the same value (the app's equivalent is
# app/src/lib/config/compose-credentials.server.ts).
#
#   compose_secret NAME   → prints $NAME if set, else NAME from the .env;
#                           fails (non-zero, message on stderr) when neither has it.
#
# COMPOSE_ENV_FILE overrides the file (the shell tests point it at a fixture).
# There is deliberately no fallback literal: a script that guessed `password`
# would authenticate against nothing on a stack created with another value.

compose_secret() {
    local name="$1" val file
    val="${!name:-}"
    if [ -z "$val" ]; then
        file="${COMPOSE_ENV_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.env}"
        if [ -f "$file" ]; then
            # Last assignment wins, as in Compose; strip one layer of quotes.
            val="$(sed -n "s/^${name}=//p" "$file" | tail -n1)"
            val="${val%\"}"; val="${val#\"}"
            val="${val%\'}"; val="${val#\'}"
        fi
    fi
    if [ -z "$val" ]; then
        echo "error: ${name} is not set — export it, or set it in the repo-root .env (see .env.example)" >&2
        return 1
    fi
    printf '%s' "$val"
}
