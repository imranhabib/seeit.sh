# Shortcuts for common seeit.sh tasks. Run `just` to list them.
# The real commands live in package.json; these recipes only wrap them.

# Paths and port match the defaults in apps/gateway/src/config.ts.
# If you set SEEIT_RECORD_DIR or SEEIT_PORT, these recipes will not see them.
# The ledger's calls are in PostgreSQL (apps/ledger/README.md), not in data/.
recordings := "data/recordings"
port := "8787"

# List the recipes.
default:
    @just --list

# Start the gateway. Only "dev" exists today: `just start dev`.
start mode="dev":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{mode}}" in
      dev) exec pnpm dev ;;
      *) echo "unknown mode '{{mode}}' (try: just start dev)" >&2; exit 1 ;;
    esac

# It asks first: data/ is git-ignored, so these files are the only copy.
# just asks before running dependencies, so "no" deletes nothing.
#
# Delete the raw JSON recordings.
[confirm("Delete all recordings? [y/N]")]
reset-recordings: _gateway-stopped _delete-recordings

# Run the unit tests.
test:
    pnpm test

# Refuse to delete files while the gateway runs: it could be writing a
# recording at that moment.
[private]
_gateway-stopped:
    #!/usr/bin/env bash
    # Without lsof the check below would always pass, so stop instead.
    if ! command -v lsof >/dev/null; then
      echo "lsof not found: cannot check whether the gateway is running" >&2
      exit 1
    fi
    if lsof -nP -iTCP:{{port}} -sTCP:LISTEN >/dev/null 2>&1; then
      echo "the gateway is running on port {{port}}; stop it (Ctrl+C in its terminal) first" >&2
      exit 1
    fi

[private]
_delete-recordings:
    rm -rf {{recordings}}
    @echo "deleted {{recordings}}"
