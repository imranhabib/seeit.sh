# Ledger: PostgreSQL foundation

This package starts a separate ledger process, opens PostgreSQL asynchronously,
and applies its own generated migrations. It exposes `GET /health` for database
readiness. Recording ingestion and read APIs are the next PRs; the gateway
still records to SQLite and does not call this service yet.

## Native local setup

Use Node 24+, pnpm, and native PostgreSQL 18. Docker is not required. If you
already run PostgreSQL, create the databases below on that instance instead.

On macOS with Homebrew:

```bash
brew install postgresql@18
export PATH="$(brew --prefix postgresql@18)/bin:$PATH"
pg_dir="$(brew --prefix)/var/postgresql@18"
pg_ctl -D "$pg_dir" -l "$pg_dir/server.log" -o '-h 127.0.0.1' start
createdb -h 127.0.0.1 seeit_ledger
createdb -h 127.0.0.1 seeit_ledger_test
```

Homebrew initializes that cluster during installation. Run `pg_ctl` only when
the cluster is stopped. These are local development examples; use your
server's authentication settings and port if they differ. Native PostgreSQL
on Linux works with the same application commands and connection URLs.

From the repository root:

```bash
pnpm install
export SEEIT_LEDGER_DATABASE_URL=postgresql://127.0.0.1:5432/seeit_ledger
pnpm --filter @seeit/ledger start
```

In another terminal:

```bash
curl -i http://127.0.0.1:8788/health
```

Expect 200 with `{"status":"ready"}` and `Cache-Control: no-store`. The process
starts listening only after migrations succeed. Later database failures return
503 with `{"status":"unavailable"}`. Logs/responses do not print database URLs,
SQL, passwords, or exception details. A startup failure exits unsuccessfully;
check the database connection and migration setup separately.

| Setting | Purpose | Default |
| --- | --- | --- |
| `SEEIT_LEDGER_DATABASE_URL` | PostgreSQL connection URL. Keep credentials out of committed files. | Required |
| `SEEIT_LEDGER_HOST` | HTTP listen address. | `127.0.0.1` |
| `SEEIT_LEDGER_PORT` | HTTP listen port. | `8788` |
| `SEEIT_TEST_DATABASE_URL` | Separate connection used to create disposable integration-test databases. | Unset; PostgreSQL tests skip in the ordinary suite |

Use `pnpm --filter @seeit/ledger dev` for watch mode. `start` does not watch
files. Ctrl+C/SIGTERM stops HTTP acceptance and drains database connections.
Stopping the ledger does not stop the existing gateway process.

## Schema and migrations

The PostgreSQL schema is `src/db/schema.ts`. After changing it, run:

```bash
pnpm --filter @seeit/ledger db:generate
```

Commit the generated SQL and metadata in this package's `drizzle/` directory.
Never edit a migration after it is committed. Migrations run at ledger startup;
the current gateway's SQLite migrations remain separate and untouched. This
foundation uses one ledger process; coordinate migrations before adding
multiple startup replicas.

All current call/body fields are preserved, with these PostgreSQL mappings:

- Timestamps are `timestamptz(3)` and become JavaScript `Date` values. Future
  HTTP ingestion converts ISO strings; read responses will serialize dates.
- Token and character counters use `bigint` in JavaScript-number mode to avoid
  PostgreSQL's 32-bit integer limit. Callers must use safe integers; ingestion
  validation belongs to the next PR.
- Timings and fractional rollout units use `double precision`, matching
  SQLite's numeric precision rather than PostgreSQL's 32-bit `real`.
- Quota, server-tool counts, and drift information use structured `jsonb`.
  Ingestion must parse the gateway's existing serialized JSON, not store those
  strings as JSON strings. SQL null means missing/unchecked; `[]` and `{}` mean
  checked and empty.
- Gzipped bodies use `bytea`/`Buffer`. Body rows reference calls with cascading
  deletion. This PR establishes storage; retention jobs come later.

No SQLite history is imported by starting this service. Existing recordings
remain at their current paths until the separate cutover PR.

## Tests and persistence check

From the repository root:

```bash
export SEEIT_TEST_DATABASE_URL=postgresql://127.0.0.1:5432/seeit_ledger_test
pnpm --filter @seeit/ledger test:db
pnpm typecheck
pnpm test
```

The test role needs `CREATEDB`. Tests create a random `seeit_test_*` database,
apply real migrations, and drop only that database afterward. They do not clear
tables in the configured database or access personal gateway recordings.
The dedicated `test:db` command fails if the URL is missing, so it cannot report
a skipped integration suite as success. Ordinary `pnpm test` skips PostgreSQL
tests when the URL is absent; set it when verifying this package.

Coverage includes all metadata fields, wide counters, fractional timings,
null/zero distinctions, structured JSON, gzip Unicode bodies, foreign-key and
primary-key constraints, cascade deletion, connection reopen/migration replay,
and healthy/unavailable readiness responses.
The suite also starts a child process with an invalid HTTP port and checks that
startup failure closes database connections instead of leaving the process idle.

For a manual persistence check, insert a synthetic row through `psql`:

```bash
psql "$SEEIT_LEDGER_DATABASE_URL" -c "INSERT INTO calls (id, started_at, harness, kind, method, path, completion, tokens_estimated) VALUES ('manual-persistence-check', now(), 'claude', 'background', 'POST', '/synthetic', 'complete', false) ON CONFLICT DO NOTHING;"
```

Stop the ledger with Ctrl+C, then restart the native database:

```bash
pg_ctl -D "$pg_dir" restart -o '-h 127.0.0.1'
pnpm --filter @seeit/ledger start
```

In another terminal, with the database URL set:

```bash
psql "$SEEIT_LEDGER_DATABASE_URL" -c "SELECT id FROM calls WHERE id = 'manual-persistence-check';"
```

The row remains because its storage belongs to PostgreSQL, not the Node
process. `pg_ctl stop -D "$pg_dir"` stops PostgreSQL without deleting data. This
direct SQL example is a developer storage check, not an application endpoint.
