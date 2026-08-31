## 用户结果

<!-- 用简单白话说明用户会看到什么变化。 -->

## 范围与取舍

<!-- 说明做了什么、不做什么，以及兼容性/安全边界。 -->

## 验证

- [ ] `npm test`
- [ ] `npm pack --dry-run`
- [ ] `cd platform && yarn typecheck`
- [ ] `cd platform && yarn test`
- [ ] `cd platform && yarn build`
- [ ] 修改 Worker 时已运行 Tier-D Docker smoke，或已说明未运行原因

## 运维影响

<!-- 配置、迁移、部署、回滚；没有请写“无”。 -->

## 安全与隐私

- [ ] 没有提交 Token、密钥、私有仓库内容、客户数据或本机绝对路径。
- [ ] 没有绕过人工 Gate、固定六阶段或角色权限边界。
