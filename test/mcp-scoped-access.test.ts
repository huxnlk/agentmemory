import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { getAllTools } from "../src/mcp/tools-registry.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../src/config.js", async (original) => ({
  ...await original<typeof import("../src/config.js")>(),
  loadConfig: () => ({ restPort: 3111, viewerPort: 3113 }),
}));

const admin = "synthetic-admin-only";
const scoped = "synthetic-scoped-only";
const allowed = ["memory_recall", "memory_smart_search"];
const req = (key: string, body?: unknown) => ({
  headers: { authorization: `Bearer ${key}` }, body, query_params: {}, method: "POST",
});
function fixture(adminSecret: string | undefined = admin) {
  const handlers = new Map<string, (input: never) => Promise<any>>();
  const middleware = new Map<string, string[]>();
  const trigger = vi.fn(async () => ({ success: true, results: [], memory: { id: "synthetic-memory" } }));
  const sdk = {
    registerFunction: (id: string | { id: string }, handler: any) => handlers.set(typeof id === "string" ? id : id.id, handler),
    registerTrigger: (route: { type: string; function_id: string; config?: { middleware_function_ids?: string[] } }) => {
      if (route.type === "http") middleware.set(route.function_id, route.config?.middleware_function_ids ?? []);
    }, trigger,
  };
  const kv = { get: async () => null, list: async () => [], set: async () => {}, delete: async () => {} };
  registerMcpEndpoints(sdk as never, kv as never, adminSecret);
  registerApiTriggers(sdk as never, kv as never, adminSecret);
  return { trigger, call: async (name: string, input: unknown) => {
    for (const id of middleware.get(name) ?? []) {
      const result = await handlers.get(id)!({ request: input } as never);
      if (result.action === "respond") return result.response;
    }
    return handlers.get(name)!(input as never);
  } };
}

describe("opt-in scoped MCP credential", () => {
  beforeEach(() => {
    vi.stubEnv("AGENTMEMORY_MCP_SECRET", scoped);
    vi.stubEnv("AGENTMEMORY_MCP_ALLOWED_TOOLS", allowed.join(","));
    vi.stubEnv("AGENTMEMORY_TOOLS", "all");
    vi.stubEnv("AGENTMEMORY_SLOTS", "false");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("lists exactly the scoped allowlist while preserving the admin catalog", async () => {
    const f = fixture();
    const restricted = await f.call("mcp::tools::list", req(scoped));
    expect(restricted.status_code).toBe(200);
    expect(restricted.body.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([...allowed].sort());
    const full = await f.call("mcp::tools::list", req(admin));
    expect(full.body.tools.some((tool: { name: string }) => tool.name === "memory_save")).toBe(true);
    expect(full.body.tools.length).toBeGreaterThan(allowed.length);
  });

  it.each(allowed)("executes permitted %s through the real MCP handler", async name => {
    const f = fixture();
    const result = await f.call("mcp::tools::call", req(scoped, { name, arguments: { query: "synthetic positive" } }));
    expect(result.status_code).toBe(200);
    expect(f.trigger).toHaveBeenCalledTimes(1);
  });

  it.each(getAllTools().map(tool => tool.name).filter(name => !allowed.includes(name)))
    ("denies %s before any SDK dispatch", async name => {
      const f = fixture();
      const result = await f.call("mcp::tools::call", req(scoped, { name, arguments: {} }));
      expect(result.status_code).toBe(403);
      expect(f.trigger).not.toHaveBeenCalled();
    });

  it("preserves admin write access", async () => {
    const f = fixture();
    const result = await f.call("mcp::tools::call", req(admin, { name: "memory_save", arguments: { content: "Synthetic approved fact" } }));
    expect(result.status_code).toBe(200);
    expect(f.trigger).toHaveBeenCalledTimes(1);
  });

  it.each(["mcp::tools::list", "mcp::tools::call"])("rejects an invalid bearer on %s", async endpoint => {
    const f = fixture();
    expect((await f.call(endpoint, req("synthetic-wrong", { name: "memory_recall", arguments: { query: "x" } }))).status_code).toBe(401);
    expect(f.trigger).not.toHaveBeenCalled();
  });

  it.each(["mcp::resources::list", "mcp::resources::read", "mcp::prompts::list", "mcp::prompts::get",
    "api::search", "api::remember", "api::forget", "api::export", "api::import"])
    ("rejects scoped credentials on %s without dispatch", async endpoint => {
      const f = fixture();
      expect((await f.call(endpoint, req(scoped, {}))).status_code).toBe(401);
      expect(f.trigger).not.toHaveBeenCalled();
    });

  it("fails closed for an explicitly empty allowlist", async () => {
    vi.stubEnv("AGENTMEMORY_MCP_ALLOWED_TOOLS", "");
    const f = fixture();
    expect((await f.call("mcp::tools::list", req(scoped))).body.tools).toEqual([]);
    expect((await f.call("mcp::tools::call", req(scoped, { name: "memory_recall" }))).status_code).toBe(403);
    expect(f.trigger).not.toHaveBeenCalled();
  });

  it("rejects unknown allowlist entries at registration", () => {
    vi.stubEnv("AGENTMEMORY_MCP_ALLOWED_TOOLS", "memory_typo");
    expect(() => fixture()).toThrow("unknown tool");
  });

  it("keeps an empty optional scoped secret disabled without changing admin access", async () => {
    vi.stubEnv("AGENTMEMORY_MCP_SECRET", "");
    const f = fixture();
    expect((await f.call("mcp::tools::list", req(scoped))).status_code).toBe(401);
    expect((await f.call("mcp::tools::list", req(admin))).status_code).toBe(200);
  });

  it.each([undefined, scoped])("refuses scoped access without a distinct configured admin secret", secret => {
    expect(() => fixture(secret === undefined ? "" : secret)).toThrow("distinct configured");
  });
});
