import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { basename, dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "public");
const port = Number(process.env.PORT || 23180);
const host = process.env.HOST || "127.0.0.1";
const workspaceRoot = resolve(process.env.CODEX_HOME_WORKSPACE || here);
const stateFile = resolve(process.env.CODEX_HOME_STATE_FILE || join(here, "data", "tasks.json"));
const codexBin = process.env.CODEX_BIN || "codex";
const maxBodyBytes = 64 * 1024;
const staticTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"]
]);

let state = { tasks: [] };
const clients = new Set();

const now = () => new Date().toISOString();

function publicTask(task) {
  return {
    id: task.id,
    threadId: task.threadId,
    turnId: task.turnId,
    workspace: task.workspace,
    prompt: task.prompt,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    events: task.events.slice(-60)
  };
}

async function loadState() {
  try {
    const loaded = JSON.parse(await readFile(stateFile, "utf8"));
    if (Array.isArray(loaded.tasks)) state = { tasks: loaded.tasks.slice(-40) };
  } catch (error) {
    if (error?.code !== "ENOENT") console.error("Unable to load task state:", error.message);
  }
}

async function persistState() {
  await mkdir(dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, stateFile);
}

function broadcast(event) {
  const payload = `event: update\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) client.write(payload);
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(data));
}

function taskForIds(threadId, turnId) {
  return state.tasks.find((task) => (threadId && task.threadId === threadId) || (turnId && task.turnId === turnId));
}

function eventText(message) {
  const params = message.params || {};
  const item = params.item || {};
  if (message.method === "item/agentMessage/delta") return params.delta || "";
  if (message.method === "item/started") return item.command ? `$ ${item.command}` : `${item.type || "work"} started`;
  if (message.method === "item/completed") {
    if (item.command) return `${item.status || "completed"}: ${item.command}`;
    if (item.text) return item.text;
    return `${item.type || "work"} ${item.status || "completed"}`;
  }
  if (message.method === "turn/completed") return `Turn ${params.turn?.status || "completed"}`;
  return message.method || "Codex event";
}

class CodexAppServer {
  constructor() {
    this.process = null;
    this.ready = false;
    this.starting = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async start() {
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.starting = this.#boot();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async #boot() {
    const child = spawn(codexBin, ["app-server"], {
      cwd: workspaceRoot,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.process = child;
    let pendingText = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pendingText += chunk;
      const lines = pendingText.split("\n");
      pendingText = lines.pop();
      for (const line of lines) this.#receive(line);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => console.error("codex app-server:", text.trim()));
    child.on("error", (error) => this.#failed(error));
    child.on("exit", (code, signal) => this.#failed(new Error(`app-server exited (${code ?? signal})`)));
    await this.call("initialize", {
      clientInfo: { name: "codex_little_home", title: "Codex Little Home", version: "0.1.0" }
    });
    this.notify("initialized", {});
    this.ready = true;
    broadcast({ type: "service", status: "ready", at: now() });
  }

  #failed(error) {
    if (this.process === null) return;
    this.ready = false;
    this.process = null;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    broadcast({ type: "service", status: "offline", detail: error.message, at: now() });
  }

  #receive(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.error("Unexpected app-server output:", line.slice(0, 500));
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve: finish, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || "Codex app-server request failed"));
      else finish(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.#handleServerRequest(message);
      return;
    }
    this.#handleNotification(message);
  }

  #handleServerRequest(message) {
    const method = message.method;
    let result = {};
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      result = { decision: "decline" };
    } else if (method === "item/permissions/requestApproval") {
      result = { permissions: [], scope: "turn" };
    } else if (method === "tool/requestUserInput") {
      result = { answers: {} };
    } else if (method === "mcpServer/elicitation/request") {
      result = { action: "decline", content: null };
    }
    this.#write({ id: message.id, result });
    broadcast({ type: "approval", method, detail: "Automatic approval is disabled.", at: now() });
  }

  #handleNotification(message) {
    const params = message.params || {};
    const threadId = params.threadId || params.thread?.id || params.item?.threadId;
    const turnId = params.turnId || params.turn?.id || params.item?.turnId;
    const task = taskForIds(threadId, turnId);
    const event = {
      id: randomUUID(),
      type: message.method || "event",
      text: eventText(message).slice(0, 4000),
      at: now()
    };
    if (task) {
      if (message.method === "turn/completed") task.status = params.turn?.status || "completed";
      task.updatedAt = event.at;
      task.events.push(event);
      if (task.events.length > 140) task.events.splice(0, task.events.length - 140);
      persistState().catch((error) => console.error("Unable to save task state:", error.message));
      broadcast({ type: "task", task: publicTask(task), event });
    } else {
      broadcast({ type: "event", event });
    }
  }

  #write(message) {
    if (!this.process?.stdin.writable) throw new Error("Codex app-server is not available");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params) {
    this.#write({ method, params });
  }

  call(method, params) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30_000);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      try {
        this.#write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
}

const codex = new CodexAppServer();

async function startTask(payload) {
  const prompt = String(payload?.prompt || "").trim();
  if (!prompt || prompt.length > 8000) throw new Error("Enter a task between 1 and 8000 characters.");
  await codex.start();
  const task = {
    id: randomUUID(),
    threadId: null,
    turnId: null,
    workspace: basename(workspaceRoot),
    prompt,
    status: "starting",
    createdAt: now(),
    updatedAt: now(),
    events: []
  };
  state.tasks.push(task);
  state.tasks = state.tasks.slice(-40);
  const threadResult = await codex.call("thread/start", {
    cwd: workspaceRoot,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "codex_little_home"
  });
  task.threadId = threadResult.thread.id;
  const turnResult = await codex.call("turn/start", {
    threadId: task.threadId,
    input: [{ type: "text", text: prompt }],
    cwd: workspaceRoot,
    approvalPolicy: "never",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [workspaceRoot], networkAccess: false }
  });
  task.turnId = turnResult.turn.id;
  task.status = turnResult.turn.status || "inProgress";
  task.updatedAt = now();
  task.events.push({ id: randomUUID(), type: "task", text: "Task sent to Codex.", at: task.updatedAt });
  await persistState();
  broadcast({ type: "task", task: publicTask(task) });
  return task;
}

async function interruptTask(id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return null;
  if (!task.threadId || !task.turnId) throw new Error("This task has no active Codex turn.");
  await codex.start();
  await codex.call("turn/interrupt", { threadId: task.threadId, turnId: task.turnId });
  task.status = "interrupting";
  task.updatedAt = now();
  await persistState();
  broadcast({ type: "task", task: publicTask(task) });
  return task;
}

function readJson(request) {
  return new Promise((resolveJson, reject) => {
    let size = 0;
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBodyBytes) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      raw += chunk;
    });
    request.on("end", () => {
      try {
        resolveJson(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    request.on("error", reject);
  });
}

async function serveStatic(request, response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = normalize(join(publicDir, requested));
  if (!filePath.startsWith(`${publicDir}/`) || !existsSync(filePath)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": staticTypes.get(extname(filePath)) || "application/octet-stream",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin"
  });
  createReadStream(filePath).pipe(response);
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;
  try {
    if (request.method === "GET" && pathname === "/api/health") {
      sendJson(response, 200, { ready: codex.ready, workspace: basename(workspaceRoot), workspacePath: workspaceRoot, now: now() });
      return;
    }
    if (request.method === "GET" && pathname === "/api/tasks") {
      sendJson(response, 200, { tasks: state.tasks.slice().reverse().map(publicTask) });
      return;
    }
    if (request.method === "GET" && pathname === "/api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      });
      response.write(`event: update\ndata: ${JSON.stringify({ type: "service", status: codex.ready ? "ready" : "starting", at: now() })}\n\n`);
      clients.add(response);
      const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 25_000);
      request.on("close", () => {
        clearInterval(heartbeat);
        clients.delete(response);
      });
      return;
    }
    if (request.method === "POST" && pathname === "/api/tasks") {
      const task = await startTask(await readJson(request));
      sendJson(response, 201, { task: publicTask(task) });
      return;
    }
    const interruptMatch = pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/interrupt$/i);
    if (request.method === "POST" && interruptMatch) {
      const task = await interruptTask(interruptMatch[1]);
      if (!task) return sendJson(response, 404, { error: "Task not found." });
      sendJson(response, 200, { task: publicTask(task) });
      return;
    }
    if (request.method === "GET" || request.method === "HEAD") return serveStatic(request, response, pathname);
    sendJson(response, 405, { error: "Method not allowed." });
  } catch (error) {
    console.error("Request failed:", error);
    sendJson(response, 400, { error: error.message || "Request failed." });
  }
});

await loadState();
server.listen(port, host, () => {
  console.log(`Codex Little Home listening on http://${host}:${port}`);
  codex.start().catch((error) => console.error("Codex app-server startup failed:", error.message));
});

function close() {
  for (const client of clients) client.end();
  codex.process?.kill("SIGTERM");
  server.close(() => process.exit(0));
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
