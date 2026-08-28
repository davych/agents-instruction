import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const businessReadmePath = fileURLToPath(
  new URL("../../../docs/business-flow/README.md", import.meta.url),
);
const technicalReadmePath = fileURLToPath(
  new URL("../../../docs/technical-design/README.md", import.meta.url),
);
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

test("DOC-BP-01 business documentation preserves the complete reviewable delivery path", async () => {
  const business = await readUtf8(businessReadmePath);
  const blocks = extractMermaidBlocks(business, "business-flow README");
  const mindmap = requiredBlock(blocks, /^mindmap$/mu, "business mindmap");
  const mainFlow = requiredBlock(blocks, /^flowchart TD$/mu, "business main flowchart");

  assertOrdered(
    mainFlow,
    [
      "绑定远端 Git HTTPS 仓库",
      "自动进入 Agent Session",
      "整理为不可变 Change Contract",
      "1 PM / BA",
      "2 Designer",
      "3 Architect",
      "4 Software Engineer",
      "5 Tester",
      "6 DevOps",
      "查看完整产物、Diff、测试、风险和 Patch",
      "由授权人决定 commit、push、PR、merge、deploy 和 release",
    ],
    "business main path",
  );
  assert.match(mainFlow, /ProductReview -->\|要求修改\| Product/u);
  assert.match(mainFlow, /ProductReview -->\|批准并继续\| Design/u);
  assert.match(mainFlow, /ReleaseReview -->\|准备就绪\| Delivery/u);

  assertOrdered(
    mindmap,
    [
      "1 PM BA",
      "2 Designer",
      "3 Architect",
      "4 Software Engineer",
      "5 Tester",
      "6 DevOps",
    ],
    "numbered six-role mindmap",
  );
  assert.match(business, /单租户 MVP[^\n]*不是[^\n]*多租户 SaaS/u);
  assert.match(business, /新任务新建 Session/u);
});

test("DOC-BP-02 business documentation keeps evidence, repository, gate, and release boundaries explicit", async () => {
  const business = await readUtf8(businessReadmePath);
  const mindmap = requiredBlock(
    extractMermaidBlocks(business, "business-flow README"),
    /^mindmap$/mu,
    "business mindmap",
  );

  assertOrdered(
    mindmap,
    [
      "证据追溯",
      "固定源码 revision",
      "不可变 Change Contract",
      "Artifact revision hash owner",
      "Review 绑定实际查看版本",
      "Diff 测试风险 Patch",
    ],
    "evidence traceability branch",
  );
  assert.match(mindmap, /一个可写主仓/u);
  assert.match(mindmap, /附加仓只有 Manifest/u);
  assert.match(mindmap, /附加仓不挂载不传正文不可写/u);
  assert.match(mindmap, /当前真实门禁是阶段 Artifact Review/u);
  assert.match(mindmap, /无通用外部写操作 Gate/u);
  assert.match(mindmap, /不自动 commit push PR merge/u);
  assert.match(mindmap, /不自动 deploy release rollback/u);

  assert.match(business, /当前只开放只读 Work Item MCP，不开放任意外部写操作/u);
  assert.match(
    business,
    /“批准阶段产物”只批准这批证据，不等于授权任何外部副作用/u,
  );
  assert.match(
    business,
    /不自动 commit、push、创建 PR、merge[^\n]*deploy、release[^\n]*rollback/u,
  );
  assert.match(business, /不把 Fake \/ Demo 执行当作真实 Agent、测试或发布证据/u);
});

test("DOC-TA-01 technical architecture identifies the trusted control plane and real runtime topology", async () => {
  const technical = await readUtf8(technicalReadmePath);
  const blocks = extractMermaidBlocks(technical, "technical-design README");
  const architecture = requiredBlock(
    blocks,
    /Trusted API control plane/u,
    "technical system architecture",
  );
  const trustBoundary = requiredBlock(
    blocks,
    /Trusted host control plane/u,
    "technical trust-boundary diagram",
  );

  for (const marker of [
    "React Web",
    "Trusted API control plane",
    "PostgreSQL",
    "Managed Workspace Root",
    "Per-project Control Pack",
    "Docker daemon",
    "Ephemeral Codex Worker",
    "Writable main workspace mount",
    "Read-only control mount",
  ]) {
    assert.ok(architecture.includes(marker), `system architecture must contain ${marker}`);
  }
  assert.match(trustBoundary, /Ephemeral Worker boundary/u);
  assert.match(trustBoundary, /Non-root read-only-rootfs Worker/u);
  assert.match(trustBoundary, /Main repository at \/workspace read-write/u);
  assert.match(trustBoundary, /Git metadata read-only/u);
  assert.match(trustBoundary, /Control Pack read-only/u);

  assert.match(technical, /API 是最高信任控制面/u);
  assert.match(
    technical,
    /Agent Sandbox[^\n]*持久受管 Workspace[^\n]*不是常驻容器/u,
  );
  assert.match(technical, /结束后容器删除，而 Workspace 继续保留/u);
  assert.match(
    technical,
    /默认 Worker 网络是普通 Docker `bridge`，因此这不是 egress 隔离/u,
  );
  assert.match(
    technical,
    /Worker 是纵深防御，不是 hostile multi-tenant sandbox/u,
  );
});

test("DOC-TA-02 technical design separates attached manifests, provider-native tests, and the real Artifact gate", async () => {
  const technical = await readUtf8(technicalReadmePath);

  assert.match(
    technical,
    /附加 `@repo` 只提供固定 revision 的有界 Manifest 摘要，不提供源码正文或写权限/u,
  );
  assert.match(
    technical,
    /附加仓不会挂载进 Worker，也不会获得 Shell、Git、网络或写权限/u,
  );
  assert.match(
    technical,
    /Provider-native Agent Runtime[^\n]*尚未接入生产六阶段/u,
  );
  assert.match(
    technical,
    /当前 Cloud 主链真正生效的人工门禁是 Artifact Review[^\n]*通用外部副作用 Gate 尚未接入生产链路/u,
  );
  assert.match(
    technical,
    /Review 必须提交页面看到的完整 current head ID 集合/u,
  );
  assert.match(
    technical,
    /平台本身不 push、不创建 PR、不合并、不部署、不发布/u,
  );
  assert.match(
    technical,
    /平台只生成\/下载 Patch，不自动 push、raise PR、merge、deploy 或 release/u,
  );

  assertOrdered(
    technical,
    [
      "| 1 | Discovery / PM-BA",
      "| 2 | Design / Designer",
      "| 3 | Architecture / Architect",
      "| 4 | Implementation / Software Engineer",
      "| 5 | Verification / Tester",
      "| 6 | Release / DevOps",
    ],
    "technical six-role handoff table",
  );
  assert.match(
    technical,
    /源码 `revision`、Control Pack `definitionVersion`、内容 `manifestHash\/contentHash`/u,
  );
});

test("DOC-MMD-01 documentation Mermaid fences are balanced and contain supported basic diagram markers", async () => {
  const documents = await Promise.all([
    readUtf8(businessReadmePath),
    readUtf8(technicalReadmePath),
  ]);
  const businessBlocks = extractMermaidBlocks(documents[0], "business-flow README");
  const technicalBlocks = extractMermaidBlocks(documents[1], "technical-design README");

  assert.ok(businessBlocks.length >= 2, "business README must retain its mindmap and main flow");
  assert.ok(technicalBlocks.length >= 3, "technical README must retain architecture, sequence, and trust diagrams");
  assert.ok(businessBlocks.some((block) => /^mindmap$/mu.test(block)));
  assert.ok(businessBlocks.some((block) => /^flowchart TD$/mu.test(block)));
  assert.ok(technicalBlocks.some((block) => /^flowchart LR$/mu.test(block)));
  assert.ok(technicalBlocks.some((block) => /^sequenceDiagram$/mu.test(block)));
  assert.ok(technicalBlocks.some((block) => /^flowchart TB$/mu.test(block)));

  for (const block of [...businessBlocks, ...technicalBlocks]) validateMermaidBlock(block);
});

test("DOC-LINK-01 every relative Markdown link in the two documentation READMEs resolves inside the repository", async () => {
  for (const sourcePath of [businessReadmePath, technicalReadmePath]) {
    const markdown = await readUtf8(sourcePath);
    const links = extractRelativeMarkdownLinks(markdown);
    assert.ok(links.length > 0, `${path.relative(repositoryRoot, sourcePath)} must contain links`);

    for (const target of links) {
      const targetWithoutFragment = target.split("#", 1)[0]!.split("?", 1)[0]!;
      if (!targetWithoutFragment) continue;
      assert.ok(
        !path.isAbsolute(targetWithoutFragment),
        `${path.relative(repositoryRoot, sourcePath)} uses an absolute local link: ${target}`,
      );
      const decoded = decodeLinkPath(targetWithoutFragment, sourcePath);
      const resolved = path.resolve(path.dirname(sourcePath), decoded);
      const relativeToRepository = path.relative(repositoryRoot, resolved);
      assert.ok(
        relativeToRepository && !relativeToRepository.startsWith(`..${path.sep}`) && relativeToRepository !== "..",
        `${path.relative(repositoryRoot, sourcePath)} link escapes the repository: ${target}`,
      );
      await assert.doesNotReject(
        stat(resolved),
        `${path.relative(repositoryRoot, sourcePath)} has a missing relative link: ${target}`,
      );
    }
  }
});

async function readUtf8(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

function extractMermaidBlocks(markdown: string, label: string): string[] {
  const lines = markdown.split(/\r?\n/u);
  const blocks: string[] = [];
  let openedAt: number | null = null;
  let content: string[] = [];

  for (const [index, line] of lines.entries()) {
    if (openedAt === null) {
      if (line.trim() === "```mermaid") {
        openedAt = index + 1;
        content = [];
      }
      continue;
    }
    if (line.trim() === "```") {
      const block = content.join("\n").trim();
      assert.ok(block, `${label} has an empty Mermaid fence opened at line ${openedAt}`);
      blocks.push(block);
      openedAt = null;
      content = [];
      continue;
    }
    assert.notEqual(
      line.trim(),
      "```mermaid",
      `${label} nests a Mermaid fence inside the block opened at line ${openedAt}`,
    );
    content.push(line);
  }

  assert.equal(openedAt, null, `${label} has an unclosed Mermaid fence at line ${openedAt}`);
  const openings = markdown.match(/^```mermaid\s*$/gmu)?.length ?? 0;
  assert.equal(blocks.length, openings, `${label} Mermaid opening/closing fence count differs`);
  return blocks;
}

function requiredBlock(blocks: readonly string[], pattern: RegExp, label: string): string {
  const block = blocks.find((candidate) => pattern.test(candidate));
  assert.ok(block, `${label} is missing`);
  return block;
}

function validateMermaidBlock(block: string): void {
  const firstLine = block.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "";
  assert.match(
    firstLine,
    /^(?:mindmap|sequenceDiagram|flowchart (?:TD|TB|BT|LR|RL))$/u,
    `unsupported or missing Mermaid diagram marker: ${firstLine}`,
  );
  if (firstLine === "mindmap") assert.match(block, /^\s*root(?:\b|\()/mu);
  if (firstLine === "sequenceDiagram") {
    assert.match(block, /^\s*participant\s+/mu);
    assert.match(block, /(?:->>|-->>)/u);
  }
  if (firstLine.startsWith("flowchart ")) assert.match(block, /(?:-->|-\.->)/u);
  assert.doesNotMatch(block, /<script\b|\bclick\s+[A-Za-z0-9_-]+/iu);
}

function assertOrdered(source: string, markers: readonly string[], label: string): void {
  let cursor = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker, cursor + 1);
    assert.ok(index > cursor, `${label} is missing or misorders ${marker}`);
    cursor = index;
  }
}

function extractRelativeMarkdownLinks(markdown: string): string[] {
  const withoutFencedCode = markdown.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gmu, "");
  const targets: string[] = [];
  const inlineLinks = /!?\[[^\]\n]*\]\(([^)\n]+)\)/gu;
  for (const match of withoutFencedCode.matchAll(inlineLinks)) {
    const target = firstLinkToken(match[1] ?? "");
    if (isRelativeLink(target)) targets.push(target);
  }
  const referenceLinks = /^\s*\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gmu;
  for (const match of withoutFencedCode.matchAll(referenceLinks)) {
    const target = (match[1] ?? match[2] ?? "").trim();
    if (isRelativeLink(target)) targets.push(target);
  }
  return [...new Set(targets)];
}

function firstLinkToken(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("<")) {
    const closing = trimmed.indexOf(">");
    return closing >= 0 ? trimmed.slice(1, closing) : trimmed;
  }
  return trimmed.match(/^\S+/u)?.[0] ?? "";
}

function isRelativeLink(target: string): boolean {
  if (!target || target.startsWith("#") || target.startsWith("//")) return false;
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target);
}

function decodeLinkPath(target: string, sourcePath: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    assert.fail(`${path.relative(repositoryRoot, sourcePath)} has an invalid encoded link: ${target}`);
  }
}
