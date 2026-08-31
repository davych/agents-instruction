# Security Policy

## 支持范围

首个稳定版本发布前，只支持默认分支的最新代码。发现问题后请先在最新代码上确认；已知修复不会自动回填到旧 commit 或自行部署的修改版本。

## 私密报告漏洞

请不要用公开 Issue 报告漏洞，也不要附上真实 Token、密钥、私有源码或客户数据。

优先使用 GitHub 的 [Private vulnerability reporting](https://github.com/davych/my-sdlc-workflow/security/advisories/new)。如果该入口在你的页面不可用，请通过仓库维护者资料中公开的私密联系方式联系，并只发送最小复现材料。

报告最好包含：

- 受影响的 commit、部署方式和配置边界；
- 可复现步骤与影响；
- 已脱敏的请求、日志或概念验证；
- 你认为可行的临时缓解方式；
- 是否已经向第三方披露。

维护者会尽量在 3 个工作日内确认收到，并在验证后协商披露时间。请在修复可用前避免公开细节。

## 重要安全边界

这个 MVP 面向一个信任域内的单操作者或小团队，不是互不信任租户共享的执行沙箱。远程真实阶段会运行仓库代码；部署者必须使用专用主机/VM、精确仓库白名单、低权限可轮换模型凭据、TLS、独立且有硬磁盘配额的 Managed Root，并定期清理无引用 Workspace。

详细的威胁、限制和部署检查表见 [platform/docs/security-model.md](platform/docs/security-model.md)。安全报告不应把已经明确记录的产品限制本身当作漏洞，除非实现绕过了文档承诺的边界。
