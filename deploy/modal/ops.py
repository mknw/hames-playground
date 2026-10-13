"""Operator commands that need the Modal SDK and the operator's own token.

None of these belong in the app: they run with a workspace token, which on the
Starter plan has deploy and delete rights, and the app only ever holds the
proxy token. Run from this directory with the same env file as the deploy:

    uv run --env-file deploy.local.env ops.py status    # containers up, no request sent
    uv run --env-file deploy.local.env ops.py prewarm   # min_containers=1: boot now, no request
    uv run --env-file deploy.local.env ops.py release   # back to scale-to-zero
    uv run --env-file deploy.local.env ops.py stats     # the last hour's engine stats

`status` is the only way to ask "is it up?" WITHOUT starting it: any HTTP
request to a scaled-to-zero server, a GET included, triggers the cold start.
It uses an SDK method Modal marks experimental; if it goes, `modal container
list --json` is the fallback.
"""

from __future__ import annotations

import json
import os
import sys

import modal

APP_NAME = os.environ.get("HAMES_MODAL_APP_NAME", "hames-small-models")
SERVER_NAME = "SmallModels"


def main(argv: list[str]) -> int:
    command = argv[1] if len(argv) > 1 else "status"
    server = modal.Server.from_name(APP_NAME, SERVER_NAME)
    if command == "status":
        containers = server._experimental_list_containers()
        print(json.dumps({"app": APP_NAME, "containers": len(containers)}))
    elif command == "prewarm":
        print(server.update_autoscaler(min_containers=1))
    elif command == "release":
        print(server.update_autoscaler(min_containers=0))
    elif command == "stats":
        print(server.stats())
    else:
        print(__doc__, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
