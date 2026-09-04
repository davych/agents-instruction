# Technology planning

Technology choices are not initialization choices. Use this guidance when the Architect first performs application architecture work, or later when an affected scope lacks enough technology guidance. A rapid-mode application architecture task may use smaller documents, but it does not skip the catalog or affected child profiles. Do not force frontend or backend planning for documentation-only, feasibility, data-only, or integration-only work that has no application stack decision.

The stable catalog is `docs/ai-sdlc/technology-profile.md`. Start it from `.ai-sdlc/templates/technology-profile.md`. It maps zero or more deployable scopes to canonical logical child paths at `/docs/ai-sdlc/technology/frontend/<scope-id>.md` and `/docs/ai-sdlc/technology/backend/<scope-id>.md`; start those documents from `.ai-sdlc/templates/technology-profile-frontend.md` and `.ai-sdlc/templates/technology-profile-backend.md`. A usable document is a real project artifact, not an unchanged template; has `Proposed` or `Confirmed` state; cites sources; and is sufficient for the current task. Follow a `Superseded` document's replacement link.

Within a profile, only `Required` and `Accepted` entries instruct implementation. `Observed` is current evidence, `Proposed` needs a decision, `Excluded` is an explicit boundary, and `Unknown` records an unresolved point. A document can be `Confirmed` while retaining non-blocking observations or unknowns, but every item needed by the current implementation must be resolved.

## First-use flow

1. Search the local index and configured read-only hosts for the catalog, listed child profiles, accepted ADRs, contracts, and relevant codebase evidence. Do not copy a bridged artifact locally or write into a code repository.
2. For each existing or hybrid code repository that is not already configured, ask for a unique lowercase kebab-case host ID and its read-only filesystem root or HTTPS base URL. Reuse an existing ID only for the same source. Add that host only to `hosts` in the delivery repository's `.ai-sdlc/artifact-hosts.json`, using the host shape documented by the `sdlc-artifact-bridge` skill and `docs/ai-sdlc/index.md` as its artifact index. Do not add or change a phase route. Resolve and read `<host-id>:/.ai-sdlc/installation.json` and `<host-id>:/.ai-sdlc/project-profile.md` before inspecting the remaining codebase evidence.
3. If no usable catalog exists, ask which application areas apply: frontend, backend, or both. Ask for the scope IDs, owning Repository IDs, source host/paths, and deployable names needed to distinguish multiple applications or services. Read an initialized code repository's stable Repository ID from its `.ai-sdlc/installation.json`; reserve an ASCII lowercase kebab-case ID for a planned greenfield repository and require that ID when it is initialized. Repository IDs must be unique across different code sources in this delivery project; reuse one only for another checkout of the same repository. A greenfield source that does not exist yet is `Planned / Not created`, not an invented host/path; register the host and replace that marker after the repository exists. Each scope ID must be one stable lowercase kebab-case segment matching `[a-z0-9]+(?:-[a-z0-9]+)*`; reject slashes, backslashes, dot segments, percent escapes, repository paths, and URLs. Do not assume one profile per repository.
4. Classify each scope as `Existing`, `Greenfield`, or `Hybrid`. Within a hybrid child profile, treat each concern independently: use the existing flow for retained technology and the greenfield flow for new or replaced technology, and record compatibility or migration boundaries between them.
5. For an existing concern, inspect manifests, lockfiles, source layout, deployment and CI configuration, API schemas, migrations, and project instructions. Record the current baseline as `Observed`. When preserving that baseline is the recommendation, record the preserved target as `Proposed`, ask a person to accept the baseline once, then change its material target entries to `Accepted`. For a material change, present the target separately and keep it `Proposed` until a person accepts it.
6. For a greenfield concern, establish product, operational, governance, team, ecosystem, hosting, compatibility, and delivery constraints before naming tools. For each material choice, present two or three viable candidates with the recommended option first and a one-sentence trade-off. Record the result as `Proposed` until a person accepts it, then change the selected entry to `Accepted`.
7. Ask about stack preferences only after constraints and current evidence are understood. Treat a preference as context, not a requirement, unless the user confirms it as one.
8. Create or update the catalog and only the affected frontend or backend child profiles from the provided templates. Keep current and target baselines distinct, cite sources, and use the entry states exactly.
9. Put shared API contracts, identity and trust boundaries, compatibility policy, and ADR references in the catalog or shared Architecture Pack. Child profiles may link to them but should not redefine them.
10. Use an ADR for a durable or cross-repository choice, migration, hard-to-reverse commitment, or exception to an architecture rule. Update `docs/ai-sdlc/index.md` for each local artifact created or changed.

## Scope coverage

Frontend profiles cover language and runtime, package and workspace tooling, build and bundling, framework and rendering, routing, UI and design-system choices, styling and themes, assets, responsive layout, state and cache ownership, forms, API handling, client session, applicable client security and privacy, accessibility, localization, browser support, performance, observability, tests, and hosting-facing configuration.

Backend profiles cover language and runtime, framework and build, service and domain boundaries, API and contract behavior, integrations and messaging, transaction and concurrency behavior, jobs, data ownership and storage, migrations and rollback, authentication, authorization, service identity, secrets and privacy, audit, observability, health and resilience, capacity, and tests.

Document only applicable areas. Prefer an explicit `Excluded` row when omission could be mistaken for a gap. Describe requirements before products and keep decisions proportional to the real system.

## Boundaries

- The Architect can create the catalog and both frontend and backend profiles without any developer agent being initialized in the delivery project.
- Technology planning does not install dependencies, scaffold an application, change production configuration, edit code repositories, or authorize a migration.
- Do not use a `Confirmed` document state to hide a material `Proposed` decision needed by implementation.
- Do not multiply profiles, services, layers, vendors, or options beyond the actual deployable scopes and decisions.
