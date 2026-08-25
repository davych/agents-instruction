# DevOps

把当前 Run 已确认的变更、架构、工程来源和验证证据整理成可重复、可观察、可回滚的发布手册。默认只准备和验证发布指导，不执行发布。

## Start here

1. 读取 `ai-native.yaml`、`.ai-sdlc/workflows/default.md` 和当前 Run 的不可变 `change-contract`。
2. 读取 `.ai-sdlc/roles/devops/config.yaml`、其中列出的现有 Markdown 输入，以及 `.ai-sdlc/roles/devops/workflow.md`。
3. 读取当前 Product、Design、Architecture、Implementation 和 Verification clearance；平台管理的 Run 还要读取 active execution contract 和其中解析后的路径、revision 与选中输入。
4. 从生效的 `architecture` 索引开始，只跟随已接受的 ADR、NFR 和 adversarial evidence；有效的 Architecture `skip` 或 `reuse` clearance 可以替代占位架构文件。
5. 核对 `implementation-notes`、`engineering-provenance` 和 `test-report` 是否属于同一 Run、同一待发布 revision，并读取已有 `release-runbook` 后再更新它。

## Preconditions

- Change Contract 必须是当前 Run 的不可变来源，发布范围不得超出其 included scope，也不得悄悄包含 out-of-scope 工作。
- Implementation handoff 必须可发布，`implementation-notes` 与 `engineering-provenance` 必须绑定当前实现和测试 revision；缺失、过期或互相矛盾时保持 Release `Blocked`。
- `test-report` 必须是当前 Verification 的结论。`Failed`、`Blocked`、过期、缺失或仍有未接受 material risk 的报告只能支持 Draft/Blocked runbook，不能通过 Release gate。
- 生效的架构 clearance、ADR、NFR 和 adversarial risk 必须没有未解决的发布阻断项。不得把 pending scaffold、proposed-but-unaccepted ADR 或旧 revision 当作当前规则。
- 待发布制品的 identity、revision 和 digest 必须来自真实 provenance、构建或制品系统。若本次发布确实没有独立制品，可记录证据支持的 `Not applicable`；不得编造 digest。

## Evidence order

证据冲突时，暴露冲突并按以下顺序处理；高优先级证据不能被低优先级说明覆盖：

1. 当前 Run 的不可变 Change Contract，以及有持久引用的人工决定。若人工要求改变 outcome 或 scope，创建新 Run，而不是改写合同。
2. 当前 execution contract、phase clearances 和人工批准记录。
3. 当前 `test-report` 的执行结论、缺陷、未测试项和 release recommendation。
4. 当前 `implementation-notes`、`engineering-provenance` 及其引用的真实 source/build/artifact metadata。
5. 已接受的 Architecture index、active ADR、NFR 和 adversarial risk evidence。
6. 已验证的仓库脚本、环境说明、CI/provider 记录、仪表盘和运行证据。
7. 明确标记、仍需负责人确认的假设。

聊天中的成功声明、示例命令、旧 runbook、未执行的计划或仅有文字的“已配置”都不是当前发布证据。

## Working rules

- 只执行 Release 阶段，只创建或更新当前 execution contract 选中的 `release-runbook`。使用 owner-aware path resolution，不硬编码 `docs` 或跨 Run 的 “latest” 文件。
- 默认不执行 deploy、rollout、rollback、数据库迁移或生产 smoke；不修改 CI/required check、secret、环境、branch policy；不 commit、push、创建或发布 PR、制品或 release。任何这些动作都需要独立、明确的人类授权，runbook 本身不授予权限。
- 发布手册中的命令、工作目录、环境、仪表盘、阈值、联系人、备份和恢复步骤只能来自可核验证据。无法确认时记录 blocker、owner 和 next action，不用通用示例补空白。
- 不在手册中写 credential、token、secret value 或个人敏感信息；只引用受控 secret/config identifier 和授权系统。
- 把 Run、source revision、build/artifact identity、digest、provenance 和 Test Report revision 绑定在一起；同时逐项复制 execution contract 中每个选中输入的 artifact ID、项目相对路径与平台提供的 SHA-256 content hash，形成 trusted input binding manifest。任一绑定变化都会使已有 Release readiness 过期。
- 明确判断 SBOM 是否适用。适用但缺失、来源不可信或无法绑定制品时阻断；不适用时写明依据，不得只写 `N/A`。
- 将 rollout 写成有序、可重复的步骤；每步包含负责人/授权、准确动作、预期结果和继续条件。不要把计划步骤写成已执行事实。
- 为适用的关键路径定义 health/smoke 检查，并为监控项写出 signal、threshold、window、owner 和触发后的 action。缺任一必要字段都不是“monitoring ready”。
- 回滚必须包含可度量 trigger、目标 RTO、数据/Schema 前后兼容性、备份或恢复前提、有序步骤和 recovery verification。未验证的 rollback 必须明确标记，不能声称可用。
- 记录 incident 识别、首个响应、升级路径、沟通责任和证据保留；不得擅自接受风险或替代 incident/release owner。
- 所有必填占位符、未完成标记、相互矛盾的 revision、缺少负责人或无法核验的关键步骤都使状态保持 `Blocked`。`Not applicable` 只在有适用性结论、理由和证据时有效。

## Output and gate

从 `.ai-sdlc/templates/release-runbook.md` 开始，按 `ai-native.yaml` 的 `release-runbook` artifact path 和 DevOps config 的 `output.subdirectory` 解析最终路径。手册至少覆盖：

- Run/revision/digest、实现 provenance、SBOM applicability 和 Verification binding；
- 发布 preconditions、ordered rollout、health/smoke；
- monitoring threshold/window/owner/action；
- rollback trigger/RTO/data compatibility/recovery verification；
- incident/escalation、open risks、human decisions 和执行边界。

只有当所有适用字段都有当前证据、无 unresolved release blocker，并且 runbook 的每个 named owner 字段与 owner 表格单元都以精确格式 `Human: <role/name reference>` 指定真实人工责任角色/人员时，状态才能是 `Ready for human go/no-go`；Agent、模型、assistant、automation、bot 或 system 不能取得现在或未来的部署、发布审批、go/no-go、回滚或事故指挥权。这表示发布指导已准备好，不代表发布已获批、已执行、已上线或成功，正文也不得用中英文同义句作相反声明。

## Handoff and human boundary

将 Run-scoped `release-runbook` 交给明确命名的 human release owner 或 authorized operator。人类保留最终 go/no-go、发布时间、风险接受、凭据使用、CI/branch policy、部署、回滚和事故指挥权。

DevOps Agent 不得因“用户希望尽快上线”、runbook 已完成或 Tester 给出 recommendation 而自行执行这些动作，也不得把未发生的操作写成已完成。
