import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("serves the workroom and rejects malformed tasks", async () => {
  const port = 24000 + Math.floor(Math.random() * 1000);
  const stateDir = await mkdtemp(join(tmpdir(), "codex-little-home-test-"));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), CODEX_BIN: "/bin/false", CODEX_HOME_STATE_FILE: join(stateDir, "tasks.json") },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    let page;
    let lastError;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        page = await fetch(`http://127.0.0.1:${port}/`);
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.ok(page, lastError?.message || "The test server did not start.");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Codex 小窝/);
    const invalid = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "" })
    });
    assert.equal(invalid.status, 400);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
});
