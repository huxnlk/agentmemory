import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSearchFunction, rebuildIndex, setHybridRanker } from "../src/functions/search.js";
import { registerSmartSearchFunction } from "../src/functions/smart-search.js";
import { registerProfileFunction } from "../src/functions/profile.js";
import { KV } from "../src/state/schema.js";
import type { Memory } from "../src/types.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

describe("memory expiry at recall time", () => {
  const handlers = new Map<string, (data: any) => Promise<any>>();
  const store = new Map<string, Map<string, any>>();
  const kv = {
    get: async (scope: string, id: string) => store.get(scope)?.get(id) ?? null,
    list: async (scope: string) => [...(store.get(scope)?.values() ?? [])],
    set: async (scope: string, id: string, value: any) => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(id, value);
      return value;
    },
  };
  const sdk = {
    registerFunction: (id: string, handler: any) => handlers.set(id, handler),
    registerTrigger: () => {},
    trigger: async ({ function_id, payload }: any) => handlers.get(function_id)!(payload),
  };
  const call = (id: string, data: any) => handlers.get(id)!(data);
  const saved: Memory = {
    id: "mem_expiring", type: "fact", title: "quartz canary", content: "quartz canary expires",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    forgetAfter: "2026-01-01T00:00:01Z", concepts: [], files: [], sessionIds: [],
    strength: 7, version: 1, isLatest: true, project: "expiry-test",
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    store.clear(); handlers.clear(); setHybridRanker(null);
    await kv.set(KV.memories, saved.id, { ...saved });
    registerSearchFunction(sdk as never, kv as never);
    registerSmartSearchFunction(sdk as never, kv as never, async () => []);
    await rebuildIndex(kv as never);
  });
  afterEach(() => vi.useRealTimers());

  it("excludes a memory that expires after indexing, without deleting its source", async () => {
    expect(JSON.stringify(await call("mem::search", { query: "quartz canary" }))).toContain(saved.content);
    vi.setSystemTime(new Date(saved.forgetAfter!));
    expect((await call("mem::search", { query: "quartz canary" })).results).toEqual([]);
    expect(await kv.get(KV.memories, saved.id)).not.toBeNull();
  });

  it("applies expiry to direct smart-search expansion", async () => {
    expect((await call("mem::smart-search", { expandIds: [saved.id] })).results).toHaveLength(1);
    vi.setSystemTime(new Date(saved.forgetAfter!));
    expect((await call("mem::smart-search", { expandIds: [saved.id] })).results).toEqual([]);
  });

  it("invalidates profile concepts when a contributing memory expires", async () => {
    await kv.set(KV.sessions, "ses_profile", {
      id: "ses_profile", project: "expiry-test", cwd: "/tmp/expiry-test",
      startedAt: "2026-01-01T00:00:00Z", status: "completed", observationCount: 0,
    });
    await kv.set(KV.memories, saved.id, { ...saved, concepts: ["expiringconcept"] });
    registerProfileFunction(sdk as never, kv as never);
    const before = await call("mem::profile", { project: "expiry-test" });
    expect(JSON.stringify(before.profile)).toContain("expiringconcept");
    vi.setSystemTime(new Date(saved.forgetAfter!));
    const after = await call("mem::profile", { project: "expiry-test" });
    expect(after.cached).toBe(false);
    expect(JSON.stringify(after.profile)).not.toContain("expiringconcept");
  });

  it("does not trust a legacy cached profile with no expiry provenance", async () => {
    await kv.set(KV.profiles, "expiry-test", {
      project: "expiry-test", updatedAt: new Date().toISOString(),
      topConcepts: [{ concept: "expiredlegacyconcept", frequency: 1 }],
      topFiles: [], conventions: [], commonErrors: [], recentActivity: [], sessionCount: 0, totalObservations: 0,
    });
    registerProfileFunction(sdk as never, kv as never);
    const result = await call("mem::profile", { project: "expiry-test" });
    expect(JSON.stringify(result)).not.toContain("expiredlegacyconcept");
  });
});
