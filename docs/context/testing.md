# Testing context

- Use public `run(args, context)` behavior and spawned CLI behavior where
  process boundaries matter.
- Create an isolated temporary target for each scenario and clean it afterward.
- Assert generated paths and semantic content, not implementation internals.
- Cover all AI tools when path/rendering behavior changes.
- Verify failure atomicity for invalid input and update races.
- Every new acceptance test names the applicable `AC-xx` criterion.
