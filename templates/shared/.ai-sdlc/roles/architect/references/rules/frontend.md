# Frontend rule pack

**Status:** Starter project policy. Greenfield technology preferences are defaults; brownfield evidence takes precedence unless a human accepts a migration decision.

**Load when:** A browser or other interactive client is created or changed.

| ID | Level | Deviation | Trigger | Requirement | Required evidence |
|----|-------|-----------|---------|-------------|-------------------|
| `FE-001` | `MUST` | `N/A` | Frontend scope exists. | Classify the affected frontend as Greenfield, Brownfield, or Hybrid from manifests, lockfiles, source, tests, runtime behavior, and accepted ADRs. For Brownfield or the existing side of Hybrid, derive the framework pattern from that evidence and do not introduce a second framework without an accepted migration ADR. | Project-mode row in Discovery, evidence paths, current Pattern, and ADR for migration. |
| `FE-002` | `DEFAULT` | `ADR required` | A Greenfield browser frontend or isolated Greenfield boundary needs a UI framework. | Use React. Record rendering mode, routing/build boundary, version source, and component ownership. In Brownfield scope, preserve the evidenced framework unless a migration ADR is accepted. | C4 client/container, frontend Pattern, dependency evidence, and ADR when the choice has material operational or migration consequences. |
| `FE-003` | `DEFAULT` | `ADR required` | React is selected for a Greenfield scope and styling infrastructure is needed. | Use Tailwind CSS through project tokens and reusable component conventions. Define how variants, responsive behavior, theming, and exceptional custom CSS are handled; avoid unexplained arbitrary-value sprawl. Brownfield styling conventions remain in force absent an accepted migration ADR. | Styling Pattern, token/design-system evidence, and visual/regression enforcement. |
| `FE-004` | `DEFAULT` | `ADR required` | A Greenfield frontend has shared client-side state whose lifecycle spans components, routes, or workflows. | Use Redux with Redux Toolkit. Keep local UI state local, define slice ownership and selector boundaries, and make an explicit separate choice for server-cache state rather than duplicating it by accident. Brownfield state management remains in force unless a migration ADR is accepted. | State ownership Pattern, tests, and ADR when adding or replacing an application-wide state model. |

## Brownfield discovery checklist

Before applying any frontend default, inspect and cite:

- package manifest and lockfile versions;
- application bootstrap, routing, rendering, and build configuration;
- styling system, tokens, and component-library conventions;
- state ownership, server-state/cache tooling, and side-effect conventions;
- representative components and tests, not only README claims.

If the sources disagree, record the conflict and follow verified behavior plus accepted ADRs. Do not describe a framework migration as a “pattern cleanup”; it is an architecture decision with cost, sequencing, and rollback consequences.
