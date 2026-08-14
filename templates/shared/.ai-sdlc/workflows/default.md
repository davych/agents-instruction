# Default Workflow

以 `ai-native.yaml` 为准，按顺序完成：

1. PM / BA：产出 product brief 和 requirements。
2. Designer：基于 requirements 建立或更新 design baseline，并产出 design spec。
3. Architect：基于 requirements 和 design spec 产出 architecture。
4. Software Engineer：完成实现并记录 implementation notes。
5. Tester：验证验收标准并产出 test report。
6. DevOps：准备发布、监控和回滚，产出 release runbook。

产物使用 `.ai-sdlc/templates/<artifact-id>.md` 作为起点。通常实际路径为 `paths.outputs` 与 `artifacts[].path` 的组合；如果角色有自己的 `config.yaml`，则在中间加入该配置唯一允许的 `output.subdirectory`。输出根始终来自 `ai-native.yaml`，默认位于目标项目的 `docs/`。

进入下一步前必须满足 YAML 中对应阶段的 gate，并在任务文件中记录交接证据。
