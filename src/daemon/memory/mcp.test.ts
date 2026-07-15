import { describe, test, expect } from "bun:test";
import { SqliteEpisodeStore } from "./store";
import { MemoryEngine } from "./engine";
import { buildMemoryMcpServer } from "./mcp";
import type { Embedder } from "./embedder";

class FakeEmbedder implements Embedder {
  readonly modelName = "fake-test";
  readonly dimensions = 8;
  async init(): Promise<void> {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(this.dimensions));
  }
  async close(): Promise<void> {}
}

describe("buildMemoryMcpServer (thin adapter over the registry)", () => {
  test("builds an in-process SDK MCP server named codeoid-memory from the shared defs", async () => {
    const engine = new MemoryEngine({ store: new SqliteEpisodeStore(":memory:"), embedder: new FakeEmbedder() });
    await engine.init();
    const server = buildMemoryMcpServer(engine, { workspaceId: "ws", sessionId: "s1" });
    // The adapter enumerates memoryToolDefs() into SDK tool()s under one server;
    // asserting the config shape exercises the whole adapter path without
    // depending on SDK internals.
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("codeoid-memory");
    expect(server.instance).toBeDefined();
  });
});
