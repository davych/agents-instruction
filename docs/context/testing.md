# Testing conventions

- Root initializer behavior uses `node --test` in `test/`.
- Platform packages use TypeScript check files named `checks/**/*.check.ts` and run them through Node with `tsx`.
- Every acceptance criterion for a material change should be cited by at least one test comment or test name.
- Keep pure structural validation independently testable before wiring it into the workflow service.
- Run root tests plus platform typecheck, tests, and build before handoff.
- Record any environment-dependent check honestly; fake-runner success is not proof of a real Codex execution.
