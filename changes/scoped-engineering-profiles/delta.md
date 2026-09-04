# Scoped engineering profiles

## Intent

Keep one Software Engineer phase owner while generating a frontend, backend, or
full-stack developer agent for the repository being initialized. Technology
choices remain an Architect responsibility and are created only when
architecture work first needs them.

## ADDED

### Engineer scope at initialization

`init` accepts `--engineer-scope frontend`, `backend`, `fullstack`, or
`frontend,backend`. The option is required when `software-engineer` is selected
and is invalid otherwise. `frontend,backend` directly denotes two separate
specialists; `fullstack` denotes one full-stack agent. Initialization never asks
for a framework, language, database, or other technology choice.

The generated installation uses schema version 2. When Software Engineer is
selected it records:

```json
{
  "roleProfiles": {
    "software-engineer": {
      "areas": ["frontend", "backend"],
      "agentMode": "separate"
    }
  }
}
```

Single-area agents use `agentMode: "specialist"`; `fullstack` uses both areas
and `agentMode: "fullstack"`. Projects without Software Engineer omit
`roleProfiles`.

### Stable repository identity

Every schema-v2 installation records a stable `repositoryId`. It defaults to a
lowercase kebab-case value derived from the target directory and can be set with
`--repository-id`. The technology catalog matches a code repository by the
exact `repositoryId` plus frontend/backend kind; evidence source host/path is a
separate field and is never used as identity. Distinct code sources within one
delivery project must use unique IDs; multiple checkouts of the same repository
reuse one. When a repository has several same-area deployables, the request and
code path select the affected Scope ID rather than combining every profile.

### Generated developer identities

The canonical role and phase owner stay `software-engineer` and
`Implementation`. Depending on the normalized profile, the selected tool gets:

- `frontend-developer`
- `backend-developer`
- `fullstack-developer`
- both `frontend-developer` and `backend-developer` in separate mode

All variants are composed from the one main
`templates/agents/software-engineer.md` source and a small scope fragment under
`templates/agent-scopes/software-engineer/`.

### External architecture source

`init` accepts optional `--architecture-source <path-or-https-url>` only for a
Software Engineer project that does not initialize a local Architect. It adds a
`delivery-project` host and points the Architecture route at that host. A path
is stored as a filesystem root; an HTTPS URL is stored as a base URL. The
bridge stays read-only and performs no cloning, copying, or synchronization.

The installation persists the normalized bridge host shape so update can
rebuild missing generated configuration without interpreting the source again:

```json
{"architectureSource":{"kind":"filesystem","root":"../delivery-project"}}
```

or:

```json
{"architectureSource":{"kind":"url","baseUrl":"https://example.com/delivery/"}}
```

### Scoped technology profiles

Architect guidance and templates define a stable catalog at
`docs/ai-sdlc/technology-profile.md` plus zero or more child profiles at:

- `docs/ai-sdlc/technology/frontend/<scope-id>.md`
- `docs/ai-sdlc/technology/backend/<scope-id>.md`

The Architect checks for existing local or bridged profiles when application
architecture first needs technology decisions. If absent or incomplete, the
Architect asks which application areas apply and asks constraints and stack
preferences. Existing systems distinguish observed current state from an
accepted target; greenfield work presents viable choices before acceptance;
hybrid systems apply either treatment per concern. Missing existing/hybrid code
sources are registered as read-only hosts in the delivery repository at first
use without adding phase routes. Rapid mode may shorten the artifact, but does
not skip it for application architecture work.

Only `Required` and `Accepted` profile entries instruct implementation.
`Observed`, `Proposed`, `Excluded`, and `Unknown` remain evidence or decision
state. Shared contracts, identity/trust boundaries, compatibility, and ADR
links are catalog-level concerns.

### Scoped implementation artifacts

Developer agents use non-colliding work areas:

- `docs/ai-sdlc/implementation/frontend/{plan,tasks,notes}.md`
- `docs/ai-sdlc/implementation/backend/{plan,tasks,notes}.md`
- `docs/ai-sdlc/implementation/fullstack/{plan,tasks,notes}.md`

The registry exposes the implementation directory as the canonical
Implementation artifact prefix.

In separate mode, a cross-area change that touches shared files names one
frontend/backend lead. The lead records the shared-file owner and edit order in
its scoped plan before parallel work; the other specialist reads that plan and
the two agents never edit the same shared file.

### General engineering discipline

The main Software Engineer source adds concise Clean Code and general technical
guidance: domain naming, cohesion, explicit dependencies and contracts,
boundary validation, honest types, correct-level error handling, controlled
side effects and concurrency, least privilege, measured performance,
behavioral tests, dependency restraint, focused diffs, and no speculative
abstraction or unrelated cleanup.

## MODIFIED

- Interactive initialization asks engineer scope only after Software Engineer
  is selected. Architect-only initialization never asks technology scope or
  stack questions.
- The project profile records generated developer identities, engineering
  areas/mode, and architecture source when applicable.
- `update` restores the exact schema-v2 developer files and shared templates
  recorded by installation metadata without changing project-owned delivery
  artifacts.
- Help and README document the new repository patterns and the separation
  between initialization scope and first-use Architect technology planning.

## REMOVED

- Schema-v1 installation metadata is no longer accepted by `update`.
- The generic generated `software-engineer` agent identity is replaced by the
  scoped developer identity or identities.
- The old root-level implementation plan, task, and notes destinations are no
  longer prescribed for new work.

## Removal audit

This is an exploratory project and the product owner explicitly approved a
clean schema-v2 break. The CLI must fail clearly before writes when updating a
schema-v1 installation. It must not add migration, compatibility, or automatic
scope inference. Existing project-owned delivery artifacts are never deleted.

## Acceptance criteria

- **AC-01** Architect-only initialization succeeds with `--roles architect`,
  records no `roleProfiles`, and never asks for engineer scope or technology
  stack.
- **AC-02** Selecting Software Engineer without a scope fails before writes in
  non-interactive use and asks exactly one scope question in interactive use.
- **AC-03** Frontend and backend scopes each record schema-v2 specialist data
  and generate only the matching tool-native developer agent. Every installation
  records a safe stable repository ID used for exact catalog matching.
- **AC-04** `fullstack` records both areas with full-stack mode and generates
  one full-stack developer; `frontend,backend` generates two specialists while
  retaining one canonical role and phase.
- **AC-05** Invalid or duplicate scopes, scope without the Software Engineer
  role, and initialization-only options on `update` fail before managed files
  change.
- **AC-06** Initialization never exposes or asks for technology-stack choices.
- **AC-07** A valid filesystem or HTTPS architecture source creates a
  `delivery-project` host and routes Architecture there; unsafe/non-HTTPS URLs,
  credentials, and a simultaneous local Architect are rejected.
- **AC-08** The bridge remains read-only, resolves the scoped catalog and child
  paths, and does not clone, copy, synchronize, or write across repositories.
- **AC-09** Architect guidance implements the existing/greenfield/hybrid
  first-use behavior, profile states, human acceptance boundary, scoped
  catalog/child model, and no-code-repository boundary.
- **AC-10** Frontend, backend, and full-stack agents contain their distinct
  responsibility boundaries, consume only Required/Accepted profile entries,
  use scoped implementation artifacts, and inherit the shared Clean Code
  guidance.
- **AC-11** Update accepts schema-v2 metadata, restores the same scoped agent
  set, preserves installation/profile/registry and delivery artifacts, and
  clearly rejects schema v1 without migration.
- **AC-12** All three supported AI tools render only their native instruction
  and scoped role files; create-only initialization and rollback guarantees are
  unchanged.
- **AC-13** The six phases and six canonical owners remain unchanged, and the
  registry contains exactly one route per phase without silent collisions.
- **AC-14** `npm test` and `npm pack --dry-run` pass, with acceptance tests that
  cite the criteria above.
