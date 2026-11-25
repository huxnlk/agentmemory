import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleToolCall, handleToolsList } from "../src/mcp/standalone.js";
import { resetHandleForTests, setLivezProbe } from "../src/mcp/rest-proxy.js";
import { InMemoryKV } from "../src/mcp/in-memory-kv.js";

vi.mock("../src/mcp/transport.js", () => ({ createStdioTransport: () => ({ start: vi.fn(), stop: vi.fn() }) }));
vi.mock("../src/config.js", async (original) => ({
  ...await original<typeof import("../src/config.js")>(), getStandalonePersistPath: () => undefined,
}));

describe("MCP-only proxy credential routing", () => {
  const base = "http://127.0.0.1:3111";
  beforeEach(() => {
    resetHandleForTests();
    vi.stubEnv("AGENTMEMORY_URL", base);
    vi.stubEnv("AGENTMEMORY_SECRET", "synthetic-scoped-only");
    vi.stubEnv("AGENTMEMORY_FORCE_PROXY", "1");
    vi.stubEnv("AGENTMEMORY_MCP_ONLY", "1");
  });
  afterEach(() => {
    resetHandleForTests();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(["memory_recall", "memory_smart_search"])("routes implemented %s only through authenticated MCP", async name => {
    const calls: Array<{ path: string; body: unknown; auth: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push({ path, body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get("authorization") });
      if (path !== "/agentmemory/mcp/call") throw new Error("unexpected raw REST credential dispatch");
      return new Response(JSON.stringify({ content: [{ type: "text", text: "synthetic allowed recall" }] }));
    }));
    const result = await handleToolCall(name, { query: "synthetic" });
    expect(result.content[0].text).toBe("synthetic allowed recall");
    expect(calls).toEqual([{ path: "/agentmemory/mcp/call", body: { name, arguments: { query: "synthetic" } }, auth: "Bearer synthetic-scoped-only" }]);
  });

  it("returns the scoped backend catalog rather than local core visibility", async () => {
    vi.stubEnv("AGENTMEMORY_TOOLS", "core");
    const fetch = vi.fn(async (url: string) => {
      expect(new URL(url).pathname).toBe("/agentmemory/mcp/tools");
      return new Response(JSON.stringify({ tools: [{ name: "memory_recall" }, { name: "memory_smart_search" }] }));
    });
    vi.stubGlobal("fetch", fetch);
    expect((await handleToolsList()).tools).toEqual([{ name: "memory_recall" }, { name: "memory_smart_search" }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not fall back or mutate local state after a forbidden tool call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })));
    const local = new InMemoryKV();
    await expect(handleToolCall("memory_save", { content: "must not save" }, local)).rejects.toThrow();
    expect(await local.list("mem:memories")).toEqual([]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a local handle even if FORCE_PROXY was accidentally omitted", async () => {
    vi.stubEnv("AGENTMEMORY_FORCE_PROXY", "");
    setLivezProbe(async () => ({ ok: false, status: 503, statusText: "synthetic unavailable" }));
    await expect(handleToolsList()).rejects.toThrow("MCP-only access requires a remote server");
    await expect(handleToolCall("memory_recall", { query: "synthetic" })).rejects.toThrow("MCP-only access requires a remote server");
  });

  it.each(["server error", "invalid inventory"])("does not advertise local fallback tools after %s without FORCE_PROXY", async failure => {
    vi.stubEnv("AGENTMEMORY_FORCE_PROXY", "");
    setLivezProbe(async () => ({ ok: true, status: 200, statusText: "synthetic reachable" }));
    vi.stubGlobal("fetch", vi.fn(async () => failure === "server error"
      ? new Response("synthetic unavailable", { status: 500 })
      : new Response(JSON.stringify({ invalid: true }))));
    await expect(handleToolsList()).rejects.toThrow();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
