# Architecture context

The CLI renders one selected AI tool's project instructions, role agents, shared
workflow templates, installation metadata, project profile, host registry, and
read-only artifact bridge into a target repository.

`bin/cli.js` owns parsing, validation, rendering, safe create/update behavior,
rollback, and project evidence detection. `templates/agents/` contains one main
Markdown source per canonical role. Small developer scope fragments may be
composed with the Software Engineer source; they are not new phase owners.

The workflow always has six ordered phases and one route per phase. Technology
selection is deferred to the Architect's first relevant work. Cross-repository
artifact access is registry-driven and read-only. Each installation records one
stable repository ID; technology catalog rows match that exact ID plus the
frontend/backend area, while source host/path remains evidence provenance.
