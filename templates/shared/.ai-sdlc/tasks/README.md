# Tasks

每个具体任务在此目录创建一个 Markdown 文件，记录目标、负责人、输入、输出、验收标准、进度和交接证据。平台管理的每个 Run 还会生成一份不可变、任务级 `change-contract`，作为产品、设计和架构影响判断的共同输入。

任务必须遵循 `ai-native.yaml` 和 `.ai-sdlc/workflows/default.md`。

角色可以因为 `direct`、`skip` 或 `reuse` 而不运行，但影响判断、来源版本、理由、验收标准和回归证据不能省略。Bug 快速通道也必须进入 Tester，不能用“无需设计/架构变更”替代验证。
