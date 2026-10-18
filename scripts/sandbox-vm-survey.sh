#!/usr/bin/env bash
# Read-only host survey; only writes private artifacts. See docs/deployment/sandbox-vm-spike.md.
set -euo pipefail
exec python3 "$(dirname "$0")/lib/sandbox_vm.py" survey "$@"
