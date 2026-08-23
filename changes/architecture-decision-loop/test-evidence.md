# Architecture decision loop test evidence

## Isolation

- Tier: Limited.
- Tests were written before the corresponding production edits, but diagnosis, test
  authoring, implementation, and review occurred in the same primary session.
- This evidence does not claim independent blind verification.

## Automated checks

| Scope | Command | Result |
|---|---|---|
| Initializer | `npm test` | Pass — 3/3 |
| Package | `env npm_config_cache=/private/tmp/architecture-loop-npm-cache npm pack --dry-run` | Pass — 79 files |
| Platform types | `yarn typecheck` | Pass |
| Platform full suite | `yarn test` | Pass — contracts 23/23, Web 64/64, API 454/454; 541/541 total |
| Platform build | `yarn build` | Pass — Vite 4059 modules; existing large-chunk warning only |
| FE-cc tests | `npm test` | Pass — 5/5 |
| FE-cc lint | `npm run lint` | Pass — zero warnings/errors |
| FE-cc build | `npm run build` | Pass — TypeScript + Vite |
| Patch hygiene | `git diff --check` | Pass |

The first sandboxed FE-cc test attempt could not write Vite's temporary config under the
external target. The same command was rerun with explicit filesystem permission and passed;
this was an environment restriction, not a product failure.

## Real-page smoke test

Against the live FE-cc Run through the local platform Web UI:

- the Architecture overview said `等待你完成 1 项决定`, not role work;
- the active item was `ARCH-OBS-002 · 浏览器错误信息写到哪里？`;
- both `本地最小诊断（推荐）` and `接入已有监控平台` were visible;
- the stale generic handoff appeared only inside old review history;
- the selection checkpoint said `先做决定，再选方案` while OBS-002 remained open;
- no human response, option selection, approval, source mutation, or DB mutation was made.

## Target preservation

After backfill and build, these formal checkpoint hashes remained unchanged:

- `architecture.md`: `e8f40f2b660c2b76766e872919811b6c9cb63d9d91b5c61a4adc88c84524c04e`
- `00-discovery-context.md`: `39949294059d10d28ffc5bfb518efecd686dbaa91d1f355f9aca3f55b1bae89f`
- `00-options.md`: `92f7d14bb063c63f66f139a408c906f949cf11749ae35708b0393e7c910dec1c`

