import { spawn, spawnSync } from "node:child_process";

const action = process.argv[2];
const containerName = "ai-sdlc-platform-postgres";
const volumeName = "ai-sdlc-platform-postgres-data";
const user = process.env.POSTGRES_USER || "ai_sdlc";
const password = process.env.POSTGRES_PASSWORD || "ai_sdlc_dev";
const database = process.env.POSTGRES_DB || "ai_sdlc";
const port = process.env.POSTGRES_PORT || "54329";

try {
  if (!/^[0-9]+$/u.test(port)) fail("POSTGRES_PORT 必须是数字");
  if (!commandWorks(["version"])) fail("未找到可用的 Docker CLI");

  if (hasCompose()) {
    const composeArgs = action === "up"
      ? ["compose", "up", "-d", "--wait", "postgres"]
      : action === "down"
        ? ["compose", "down"]
        : action === "logs"
          ? ["compose", "logs", "--follow", "postgres"]
          : null;
    if (!composeArgs) fail("用法：yarn db:up | yarn db:down | yarn db:logs");
    await runDocker(composeArgs);
  } else if (action === "up") {
    await fallbackUp();
  } else if (action === "down") {
    await fallbackDown();
  } else if (action === "logs") {
    await runDocker(["logs", "--follow", containerName]);
  } else {
    fail("用法：yarn db:up | yarn db:down | yarn db:logs");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function hasCompose() {
  return commandWorks(["compose", "version"]);
}

function commandWorks(args) {
  return spawnSync("docker", args, { stdio: "ignore" }).status === 0;
}

async function fallbackUp() {
  if (commandWorks(["inspect", containerName])) {
    if (!commandWorks(["inspect", "--format", "{{.State.Running}}", containerName])) {
      fail(`无法读取容器 ${containerName}`);
    }
    const running = spawnSync(
      "docker",
      ["inspect", "--format", "{{.State.Running}}", containerName],
      { encoding: "utf8" }
    ).stdout.trim() === "true";
    if (!running) await runDocker(["start", containerName]);
  } else {
    await runDocker([
      "run", "-d",
      "--name", containerName,
      "-e", `POSTGRES_USER=${user}`,
      "-e", `POSTGRES_PASSWORD=${password}`,
      "-e", `POSTGRES_DB=${database}`,
      "-p", `${port}:5432`,
      "-v", `${volumeName}:/var/lib/postgresql/data`,
      "--health-cmd", `pg_isready -U ${user} -d ${database}`,
      "--health-interval", "2s",
      "--health-timeout", "5s",
      "--health-retries", "20",
      "postgres:16-alpine"
    ]);
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = spawnSync(
      "docker",
      ["inspect", "--format", "{{.State.Health.Status}}", containerName],
      { encoding: "utf8" }
    );
    if (result.status === 0 && result.stdout.trim() === "healthy") {
      process.stdout.write(`PostgreSQL 已就绪：127.0.0.1:${port}\n`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  fail(`PostgreSQL 健康检查超时；运行 yarn db:logs 查看 ${containerName}`);
}

async function fallbackDown() {
  if (!commandWorks(["inspect", containerName])) {
    process.stdout.write("PostgreSQL 容器未运行。\n");
    return;
  }
  await runDocker(["rm", "--force", containerName]);
  process.stdout.write(`已停止 PostgreSQL；数据卷 ${volumeName} 保留。\n`);
}

function runDocker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0
      ? resolve()
      : reject(new Error(`docker ${args[0]} 失败（${signal || code}）`)));
  });
}

function fail(message) {
  throw new Error(message);
}
