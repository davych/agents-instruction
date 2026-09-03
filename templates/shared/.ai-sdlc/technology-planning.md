# Technology planning

Use this guidance when no usable `docs/ai-sdlc/technology-profile.md` can be found locally or through the configured artifact routes. In `formal` delivery mode, use it when the Architect starts its first Architecture task. In `rapid` mode, use it only when the current increment needs a material technology choice; a missing profile alone is not a reason to create one.

A usable profile is a real project artifact rather than an unchanged template, has an explicit `Proposed` or `Confirmed` status, cites its decision sources, and contains enough constraints or choices for the current Architecture task. A `Confirmed` profile is reused without repeating its settled questions. A `Proposed` profile is extended only for unresolved choices required by the current work.

## First-use flow

1. Search the local artifact index, the Architecture route, and other relevant configured routes for a technology profile and accepted ADRs.
2. Inspect current project evidence such as manifests, lockfiles, source layout, deployment configuration, CI, API schemas, and project instructions. Existing evidence is not a request to migrate it.
3. If no usable profile exists, ask for the planning direction before technology-specific questions. Offer: preserve the verified current technology, plan the target technology now, or remain technology-neutral and record constraints only. Recommend preserving the current technology when an established system fits; otherwise recommend the least committal direction that still supports the current work.
4. Identify only the technical areas required by the confirmed product, design, integration, operational, or governance needs.
5. Separate observed facts, explicit constraints, proposed choices, accepted decisions, and unknowns.
6. Ask the user only about material choices that cannot be resolved from evidence and are relevant to the selected direction. Ask one decision at a time with two or three viable options, the recommended option first, and a one-sentence trade-off for each.
7. Create `docs/ai-sdlc/technology-profile.md` from `.ai-sdlc/templates/technology-profile.md`. Mark unresolved content as `Proposed` or `Unknown`; never imply acceptance.
8. Add the profile to `docs/ai-sdlc/index.md` and cite the sources used.

## Coverage

Consider frontend and interaction technology, services and APIs, data and storage, integrations and messaging, runtime and deployment, security and privacy, observability and operations, and validation and quality. Document only areas that apply, but state why an area was excluded when that could otherwise be mistaken for an omission.

Describe requirements before products. Record a named language, framework, vendor, or tool only when it is established by evidence, required by a real constraint, or chosen by the user. Use ADRs for durable choices with meaningful alternatives, migration cost, cross-repository impact, or exceptions.

## Boundaries

- The Architect can initialize this profile without Software Engineer, Tester, or DevOps agents being present.
- Technology planning does not install dependencies, scaffold an application, change production configuration, or authorize a migration.
- Do not force a frontend or backend choice when the project is documentation-only, integration-focused, data-focused, or still exploring feasibility.
- Do not turn a preference into a requirement or a detected tool into an accepted standard.
- If the current work needs no technology decision, keep the profile small and record only confirmed constraints and relevant unknowns.
