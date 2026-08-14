# Architect workflow

Turn confirmed product and design intent into divergent options and a decision-ready architecture pack.

## Steps

1. Read `ai-native.yaml`, `.ai-sdlc/workflows/default.md`, `.ai-sdlc/roles/architect/config.yaml`, every configured input, and the existing architecture pack.
2. Resolve every input and output through the global artifact registry and the artifact owner's role config. Do not hardcode `docs` or the default Architect directory.
3. Read [architecture-rules.md](references/architecture-rules.md). Separate confirmed facts, measured evidence, assumptions, recommendations, and decisions that need a human owner.
4. Create or update the four-layer context from `.ai-sdlc/templates/architecture-discovery-context.md`. Expose at least five important hidden assumptions without presenting them as facts.
5. Create at least `quality.minimum_options` genuinely different options from `.ai-sdlc/templates/architecture-options.md`. Score them against evidence-backed criteria and make a provisional recommendation.
6. Create or update the resolved `architecture` artifact from `.ai-sdlc/templates/architecture.md`. Link the context and options as active, and mark every selected-state artifact as pending.
7. Check for human selection evidence. If it is absent, set the index to `Awaiting human selection` and stop. If it is present, verify that it selects exactly one documented option before continuing.
8. Create the C4 context and container views from the `.mmd` templates. Add only evidence-backed elements and render-check both files in the project's actual Mermaid runtime.
9. Record each major decision as a proposed ADR from `.ai-sdlc/templates/architecture-adr.md`. Put it in the resolved `architecture-adrs` directory as `ADR-<three-digits>-<kebab-case-title>.md`. Preserve existing IDs and include rejected alternatives, consequences, and a short agent-readable summary with explicit `Must` and `Do not` rules.
10. Record only patterns that were considered. Place each adopted pattern on a named C4 L2 element and state its trade-off.
11. Create at least `quality.minimum_nfrs` measurable NFR budgets across at least `quality.minimum_nfr_families` relevant families from `.ai-sdlc/templates/architecture-nfrs.md`. Each complete budget needs a target, measurement window, responsible container, test method, evidence, and a failure signal. If the configured floor does not fit the project, block and ask a human to change it; never add irrelevant NFRs to reach a number.
12. Ask a fresh session or independent reviewer to run the three-stressor premortem from `.ai-sdlc/templates/architecture-adversarial.md`. If independence cannot be shown, mark the review as pending.
13. Refresh the index with current links, status, freshness, ADR applicability, and open decisions.
14. Run the completion checks below and return unresolved decisions to the human owner.

## Completion checks

- Options exist before any selected-state C4 diagram.
- Human selection evidence is recorded before C4, ADR, or pattern choices are treated as active.
- C4 L1 shows the focal system and every evidenced person or external system, without container detail.
- C4 L2 shows every evidenced executable or deployable container, data owner, high-level technology, and communication path.
- Every active ADR has consequences and agent-readable `Must` and `Do not` rules.
- Every ADR appears once in the architecture index, and no existing ADR ID was reused or renumbered.
- Every active pattern has a C4 L2 location, a reason, and a trade-off.
- The NFR set reaches both configured minimums, or the pack records a human-approved config change.
- No approved NFR is missing a numeric or binary target, a window, or a test method.
- The adversarial review covers load, malicious input, and external dependency failure, with at least the configured findings per stressor.
- The index clearly separates accepted, proposed, blocked, and pending material.
- Human acceptance and its evidence are recorded before the architecture phase is complete.

Keep the index at `Ready for human acceptance` until a human accepts it. Do not fill the acceptance fields yourself or claim the pack is complete when a human decision, measurable target, render check, or independent review is missing.
