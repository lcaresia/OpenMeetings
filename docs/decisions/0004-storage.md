# 0004: SQLite through node:sqlite, search in memory; Postgres later

Status: accepted

## Context

The spec asks for SQLite by default with sqlite-vec for embeddings, and Postgres + pgvector as
an option.

- `better-sqlite3` is a native module: it has to compile or download a prebuilt binary for every
  platform and architecture, which complicates the arm64 Docker image and `npx` installs.
- Node 22 ships `node:sqlite`, a synchronous driver with no native dependency. It still prints
  an "experimental" warning once.
- sqlite-vec is a loadable extension (also native, prebuilt per platform).
- One team's meetings produce tens of thousands of searchable chunks at most. A dot product
  over that many 768-dimension vectors takes milliseconds.

## Decision

- Storage uses `node:sqlite`. The warning is filtered when the module loads.
- Embeddings are stored as normalized float32 blobs; search is a dot product in memory.
  Chunks embedded with another model (different dimension) are skipped instead of failing.
- Everything goes through the `MeetingStore` interface (`apps/server/src/storage/store.ts`).
  When a deployment outgrows in-memory search, a sqlite-vec or Postgres + pgvector store
  implements the same interface. `storage.driver: postgres` is accepted by the config schema
  and refused at startup with a pointer to this ADR until that store exists.

## Consequences

Zero native dependencies in the server: the same image builds for amd64 and arm64, and `npx
open-meetings` works anywhere Node 22 runs. Postgres is not available in v0.1.
