#!/usr/bin/env bash
# Dry-run by default. No host mutation without --apply and explicit step flags.
set -euo pipefail
exec python3 "$(dirname "$0")/lib/sandbox_vm.py" spike "$@"
