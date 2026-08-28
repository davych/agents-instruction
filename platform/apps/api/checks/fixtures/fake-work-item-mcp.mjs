import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "fake-work-item", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method !== "tools/call") return;

  const args = message.params?.arguments ?? {};
  const reference = args.issueId ?? args.identifier ?? args.reference;
  if (reference === "HANG-1") return;
  if (reference === "SLOW-TERM-1") {
    process.on("SIGTERM", () => undefined);
    setInterval(() => undefined, 10_000);
  }
  if (reference === "TOO-LARGE-1") {
    process.stdout.write("x".repeat(32 * 1024));
    return;
  }
  if (reference === "ERROR-1") {
    process.stderr.write(`adapter detail must stay private: ${process.env.MCP_TEST_TOKEN}\n`);
    respond(message.id, {
      isError: true,
      content: [{ type: "text", text: "private upstream error" }],
    });
    return;
  }
  if (
    message.params?.name !== "get_issue"
    || args.cloudId !== "cloud-42"
    || process.env.MCP_TEST_TOKEN !== "server-side-token"
  ) {
    respond(message.id, {
      isError: true,
      content: [{ type: "text", text: "server-owned arguments were not preserved" }],
    });
    return;
  }

  const issue = {
    issue: {
      identifier: String(reference),
      title: `Issue ${reference}`,
      description: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Plain description" }] }],
      },
      url: `https://issues.example.test/browse/${encodeURIComponent(String(reference))}`,
      labels: [{ name: "backend" }, { name: "cloud" }],
      acceptance: [
        "Returns a normalized draft",
        "Keeps credentials on the server",
        ...(process.env.MCP_UNMAPPED_SECRET === undefined ? [] : ["UNMAPPED SECRET LEAKED"]),
      ],
      kind: "bug",
    },
  };
  if (reference === "TEXT-1") {
    respond(message.id, {
      content: [{ type: "text", text: JSON.stringify(issue) }],
    });
    return;
  }
  respond(message.id, { structuredContent: issue });
});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
