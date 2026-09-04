# Gap log

## Scoped engineering profiles

- Confirmed: clean schema-v2 break; no schema-v1 migration.
- Confirmed: `software-engineer` remains the single canonical Implementation
  owner even when two local specialist agents are generated.
- Confirmed: technology choices are absent from initialization and created by
  the Architect on first relevant work.
- Confirmed: architecture-source access is read-only through the existing
  bridge model.
- Confirmed: a stable repository ID is recorded at initialization so bridged
  technology profiles can be matched without guessing from paths or filenames.
- Intentionally deferred: automatic monorepo workspace discovery, profile
  synchronization, remote writes, runtime orchestration, and technology preset
  catalogs. These require demonstrated need.
