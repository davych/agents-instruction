import assert from "node:assert/strict";
import test from "node:test";

import type {
  AskProviderCheckDto,
  AskProviderId,
  AskProviderStatusDto,
} from "@ai-sdlc/contracts";

import { AskProviderRegistry } from "../src/services/llm/provider-registry.ts";
import type {
  AskLlmCompleteRequest,
  AskLlmCompleteResponse,
  AskLlmProvider,
} from "../src/services/llm/types.ts";

const COMPLETE_REQUEST: AskLlmCompleteRequest = {
  systemPrompt: "Return one bounded answer.",
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 32,
};

class VersionedProvider implements AskLlmProvider {
  readonly calls: string[] = [];

  constructor(
    readonly id: AskProviderId,
    private readonly marker: string,
    private readonly configured = true,
  ) {}

  status(): AskProviderStatusDto {
    return {
      id: this.id,
      label: `${this.id}-${this.marker}`,
      configured: this.configured,
      model: this.configured ? `${this.marker}-model` : null,
      protocol: this.id === "ollama"
        ? "ollama-chat"
        : this.id === "lmstudio"
          ? "openai-chat"
          : "openai-responses",
      dataBoundary: this.id === "openai" ? "remote" : "local",
      endpointLabel: `${this.marker}.example.test`,
      capabilities: {
        streaming: false,
        structuredOutput: true,
        toolCalling: this.configured,
      },
      message: this.configured ? "ready" : "disabled",
    };
  }

  async check(): Promise<AskProviderCheckDto> {
    return {
      providerId: this.id,
      state: this.configured ? "ready" : "not_configured",
      model: this.configured ? `${this.marker}-model` : null,
      message: this.configured ? "ready" : "disabled",
      checkedAt: new Date(0).toISOString(),
    };
  }

  async complete(): Promise<AskLlmCompleteResponse> {
    this.calls.push(this.marker);
    return {
      text: this.marker,
      model: `${this.marker}-model`,
      usage: { inputTokens: null, outputTokens: null },
    };
  }
}

function registryWith(openai: AskLlmProvider): AskProviderRegistry {
  return new AskProviderRegistry([
    openai,
    new VersionedProvider("lmstudio", "lm-v1"),
    new VersionedProvider("ollama", "ollama-v1"),
    new VersionedProvider("custom", "custom-v1"),
  ]);
}

test("PROV-AC-02/08: the dynamic registry keeps four fixed slots and replaces only the selected slot", async () => {
  const openaiV1 = new VersionedProvider("openai", "openai-v1");
  const openaiV2 = new VersionedProvider("openai", "openai-v2");
  const registry = registryWith(openaiV1);

  assert.deepEqual(
    registry.statuses().map(({ id }) => id),
    ["openai", "lmstudio", "ollama", "custom"],
  );

  registry.replace("openai", openaiV2, 2);

  assert.equal(registry.recordVersion("openai"), 2);
  assert.equal(registry.status("openai").model, "openai-v2-model");
  assert.equal(registry.status("lmstudio").model, "lm-v1-model");
  assert.equal((await registry.complete("openai", COMPLETE_REQUEST)).text, "openai-v2");
  assert.deepEqual(openaiV1.calls, []);
  assert.deepEqual(openaiV2.calls, ["openai-v2"]);
  assert.throws(
    () => registry.replace("openai", new VersionedProvider("custom", "wrong-id"), 3),
    /identity mismatch/u,
  );
});

test("PROV-AC-09: an async Provider scope keeps one immutable endpoint/model snapshot across replacement", async () => {
  const openaiV1 = new VersionedProvider("openai", "origin-a-secret-a");
  const openaiV2 = new VersionedProvider("openai", "origin-b-secret-b");
  const registry = registryWith(openaiV1);
  let releasePinned!: () => void;
  let markPinned!: () => void;
  const pinnedEntered = new Promise<void>((resolve) => { markPinned = resolve; });
  const pinnedGate = new Promise<void>((resolve) => { releasePinned = resolve; });

  const inFlight = registry.runWithProvider("openai", async () => {
    assert.equal(registry.recordVersion("openai"), 1);
    assert.equal(registry.status("openai").endpointLabel, "origin-a-secret-a.example.test");
    markPinned();
    await pinnedGate;

    // Nested Provider-aware helpers in Ask, DeepWiki, or an Agent Turn must
    // inherit the original snapshot instead of silently repinning mid-turn.
    return registry.runWithProvider("openai", async () => ({
      version: registry.recordVersion("openai"),
      status: registry.status("openai"),
      response: await registry.complete("openai", COMPLETE_REQUEST),
    }));
  });

  await pinnedEntered;
  registry.replace("openai", openaiV2, 2);

  const nextRequest = await registry.complete("openai", COMPLETE_REQUEST);
  assert.equal(nextRequest.text, "origin-b-secret-b");
  assert.equal(registry.recordVersion("openai"), 2);

  releasePinned();
  const pinned = await inFlight;
  assert.equal(pinned.version, 1);
  assert.equal(pinned.status.endpointLabel, "origin-a-secret-a.example.test");
  assert.equal(pinned.response.text, "origin-a-secret-a");
  assert.deepEqual(openaiV1.calls, ["origin-a-secret-a"]);
  assert.deepEqual(openaiV2.calls, ["origin-b-secret-b"]);
});

test("PROV-AC-06/07: a stale publisher cannot roll the Registry back to an older record version", () => {
  const registry = registryWith(new VersionedProvider("openai", "v1"));
  registry.replace("openai", new VersionedProvider("openai", "v2"), 2);

  assert.throws(
    () => registry.replace("openai", new VersionedProvider("openai", "stale-v1"), 1),
    /version|版本|stale|旧/iu,
  );
  assert.equal(registry.recordVersion("openai"), 2);
  assert.equal(registry.status("openai").model, "v2-model");
});
