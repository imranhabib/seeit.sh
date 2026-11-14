# Shortcuts for common seeit.sh tasks. Run `just` to list them.
# The real commands live in package.json; these recipes only wrap them.

# Paths match the defaults in apps/gateway/src/config.ts.
# If you set SEEIT_DB or SEEIT_RECORD_DIR, these recipes will not see them.
db := "data/seeit.db"
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

# Delete the ledger database and the raw recordings.
reset: reset-db reset-sessions

# SQLite runs in WAL mode: recent rows live in the -wal file, so delete all three.

# Delete the ledger database only. A new one is created on the next start.
reset-db: _gateway-stopped
    rm -f {{db}} {{db}}-wal {{db}}-shm
    @echo "deleted {{db}} (and -wal, -shm)"

# Delete the raw recordings only.
reset-sessions: _gateway-stopped
    rm -rf {{recordings}}
    @echo "deleted {{recordings}}"

# Run the unit tests.
test:
    pnpm test

# Refuse to delete files while the gateway runs: it would keep writing to the
# deleted database, and the new one would not appear until a restart.
[private]
_gateway-stopped:
    #!/usr/bin/env bash
    if lsof -nP -iTCP:{{port}} -sTCP:LISTEN >/dev/null 2>&1; then
      echo "the gateway is running on port {{port}}; stop it (Ctrl+C in its terminal) first" >&2
      exit 1
    fi
