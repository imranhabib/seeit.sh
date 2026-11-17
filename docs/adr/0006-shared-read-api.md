# 0006 — Shared read API for the dashboard and CLI

**Status:** accepted

## Decision

The dashboard and CLI read recorded usage through the gateway's HTTP API
under `/api`. SQLite remains the source of truth. Neither consumer opens the
database directly. `seeit sql` remains the planned local-only exception.

Register API routes before the harness proxy and reserve the `/api` namespace,
including unknown paths and unsupported methods, so they never go upstream.
Use explicit metadata selections, bounded list responses, and `no-store`
response caching. Raw bodies, request URLs, and quota-header JSON are excluded
from the first endpoints; evidence and normalized quota need separate views.

## Why

- Both consumers need the same usage and session definitions.
- The gateway can later run on a private server where clients cannot read
  its database file.
- A metadata-only first slice can be tested without changing stream parsing,
  storage, or dependencies, and without exposing captured source content.

## Consequences

- Start with call list and detail; add session and aggregate views in later,
  separately reviewable changes. See [the API contract](../read-api.md).
- Unknown values remain null; estimates retain their flags. The API reflects
  ledger values and does not repair existing parser limitations.
- Lists use offset pagination for now. Order by start time and ID to break
  ties. New calls can shift page boundaries; polling clients restart at the
  first page. Add cursor pagination if concurrent browsing needs a stable
  snapshot, rather than promising that offset pages form one.
- Writes, SQL execution, authentication for remote deployment, and access to
  raw evidence are separate work. Keep the existing local binding default.
- Reads do not contact providers, invoke parsers, decompress bodies, or change
  stored calls. The proxy streaming rules remain unchanged.
