import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("MCP-only process persistence isolation", () => {
  it.each(["SIGINT", "SIGTERM"])("does not read or overwrite a fallback file on %s", signal => {
    const directory = mkdtempSync(join(tmpdir(), "mcp-only-persistence-"));
    const path = join(directory, "standalone.json");
    const replacement = JSON.stringify({ "mem:memories": { external: { content: "concurrent synthetic edit" } } });
    writeFileSync(path, JSON.stringify({ "mem:memories": { original: { content: "original synthetic snapshot" } } }));
    const program = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      let reads = 0;
      const target = ${JSON.stringify(path)};
      const original = fs.readFileSync;
      fs.readFileSync = function(file, ...args) {
        if (String(file) === target) reads++;
        return original.call(this, file, ...args);
      };
      syncBuiltinESMExports();
      await import(${JSON.stringify(pathToFileURL(resolve("src/mcp/standalone.ts")).href)});
      fs.writeFileSync(target, ${JSON.stringify(replacement)});
      console.log(JSON.stringify({ reads }));
      process.emit(${JSON.stringify(signal)});
    `;
    try {
      const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], {
        encoding: "utf8", timeout: 15_000, env: {
          ...process.env, STANDALONE_PERSIST_PATH: path,
          AGENTMEMORY_ENV_FILE: join(directory, "absent.env"),
          AGENTMEMORY_MCP_ONLY: "1", AGENTMEMORY_FORCE_PROXY: "1",
          AGENTMEMORY_URL: "http://127.0.0.1:59999", AGENTMEMORY_SECRET: "synthetic-scoped-only",
        }, stdio: ["ignore", "pipe", "pipe"],
      });
      expect(JSON.parse(output.trim())).toEqual({ reads: 0 });
      expect(readFileSync(path, "utf8")).toBe(replacement);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
