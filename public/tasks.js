const $ = (selector) => document.querySelector(selector);
const tasks = new Map();
const activity = [];
const seenEvents = new Set();
const active = new Set(["inProgress", "starting", "interrupting"]);
let selectedTaskId = null;
let modelLabel = "Codex";
let refreshInFlight = false;

const panel = $("#task-panel");
const toggle = $("#panel-toggle");

function clock(value) {
  const time = new Date(value);
  return Number.isNaN(time.valueOf()) ? "刚刚" : time.toLocaleTimeString("zh-CN", { hour:"2-digit", minute:"2-digit" });
}

function cleanText(value) {
  return String(value || "").replace(/\n?\[\[DONE\]\]\s*$/u, "").trimEnd();
}

function roomMode(task) {
  if (!task) return { mode:"idle", title:"安静待命", copy:"拖动房屋查看每个房间。", tag:"待命" };
  if (active.has(task.status)) return { mode:"working", title:"正在工作", copy:"书桌已亮起，Codex 正在处理任务。", tag:"工作中" };
  if (task.status === "completed") return { mode:"done", title:"任务完成", copy:"工作记录保存在右下角。", tag:"完成" };
  return { mode:"blocked", title:"需要处理", copy:"任务在结束前停下了。", tag:"受阻" };
}

function updateRoom(task) {
  const state = roomMode(task);
  $("#scene-state").textContent = state.title;
  $("#scene-copy").textContent = state.copy;
  $("#state-tag").textContent = state.tag;
  window.dispatchEvent(new CustomEvent("codex-home:update", { detail:{ ...state, task } }));
}

function addActivity(event) {
  if (!event?.text) return;
  if (event.id) {
    if (seenEvents.has(event.id)) return;
    seenEvents.add(event.id);
    if (seenEvents.size > 600) seenEvents.clear();
  }
  const previous = activity.at(-1);
  if (event.type === "item/agentMessage/delta" && previous?.type === event.type) {
    previous.text += event.text;
    previous.at = event.at;
  } else if (previous?.text === event.text && previous?.type === event.type) {
    return;
  } else {
    activity.push({ ...event, text:cleanText(event.text) });
  }
  while (activity.length > 70) activity.shift();
  const feed = $("#event-feed");
  feed.replaceChildren();
  for (const item of [...activity].reverse()) {
    const row = $("#event-template").content.firstElementChild.cloneNode(true);
    row.querySelector("time").textContent = clock(item.at);
    row.querySelector("span").textContent = item.text;
    feed.append(row);
  }
}

function answerFor(task) {
  const completed = [...(task.events || [])].reverse().find((event) => event.type === "item/completed" && event.kind === "agentMessage" && event.text);
  if (completed) return cleanText(completed.text);
  const deltas = (task.events || []).filter((event) => event.type === "item/agentMessage/delta").map((event) => event.text).join("");
  return cleanText(deltas) || (active.has(task.status) ? "Codex 正在处理，输出会自动刷新。" : "这个任务没有可展示的文字输出。");
}

function renderOutput(task) {
  const output = $("#task-output");
  const meta = $("#output-meta");
  const copy = $("#copy-output");
  if (!task) {
    meta.textContent = "等待任务";
    output.textContent = "创建任务后，完整回复会显示在这里。";
    copy.disabled = true;
    return;
  }
  meta.textContent = `${task.status} · ${clock(task.updatedAt || task.createdAt)}`;
  output.textContent = answerFor(task);
  copy.disabled = !output.textContent;
}

function mergeTask(task) {
  if (!task?.id) return;
  tasks.set(task.id, task);
  if (!selectedTaskId) selectedTaskId = task.id;
  for (const event of task.events || []) addActivity(event);
  render();
}

function render() {
  const list = [...tasks.values()].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  $("#task-count").textContent = String(list.length);
  const root = $("#task-list");
  root.replaceChildren();
  if (!list.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "还没有任务。";
    root.append(empty);
    renderOutput();
    updateRoom();
    return;
  }
  if (!list.some((task) => task.id === selectedTaskId)) selectedTaskId = list[0].id;
  for (const task of list) {
    const row = $("#task-template").content.firstElementChild.cloneNode(true);
    row.classList.toggle("selected", task.id === selectedTaskId);
    row.querySelector(".task-prompt").textContent = task.prompt;
    row.querySelector("time").textContent = clock(task.updatedAt || task.createdAt);
    const label = row.querySelector(".task-status");
    label.textContent = task.status;
    if (task.status === "completed") label.classList.add("completed");
    if (["failed", "interrupted"].includes(task.status)) label.classList.add("failed");
    row.querySelector(".view-button").addEventListener("click", () => { selectedTaskId = task.id; render(); });
    const stop = row.querySelector(".stop-button");
    stop.hidden = !active.has(task.status);
    stop.addEventListener("click", () => interrupt(task.id, stop));
    root.append(row);
  }
  const selected = tasks.get(selectedTaskId) || list[0];
  renderOutput(selected);
  updateRoom(list[0]);
}

async function api(path, options={}) {
  const response = await fetch(path, { headers:{ "Content-Type":"application/json" }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败。");
  return data;
}

function setFormError(message="") {
  const error = $("#form-error");
  error.textContent = message;
  error.hidden = !message;
  $("#prompt").setAttribute("aria-invalid", String(Boolean(message)));
}

function setConnection(online) {
  $("#connection-text").textContent = online ? `已连接 ${modelLabel}` : "正在重连 Codex";
  $("#signal").className = `signal ${online ? "online" : "offline"}`;
}

async function interrupt(id, button) {
  button.disabled = true;
  try {
    mergeTask((await api(`api/tasks/${id}/interrupt`, { method:"POST" })).task);
  } catch(error) {
    button.disabled = false;
    addActivity({ type:"error", text:error.message, at:new Date().toISOString() });
  }
}

async function refreshTasks() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const history = await api("api/tasks");
    for (const task of history.tasks) mergeTask(task);
  } catch(error) {
    addActivity({ type:"error", text:error.message, at:new Date().toISOString() });
  } finally {
    refreshInFlight = false;
  }
}

$("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = $("#prompt").value.trim();
  if (!prompt) return $("#prompt").focus();
  const button = $("#start-button");
  setFormError();
  button.disabled = true;
  button.textContent = "正在交给 Codex";
  $("#form-hint").textContent = "正在建立任务线程...";
  try {
    const task = (await api("api/tasks", { method:"POST", body:JSON.stringify({ prompt }) })).task;
    selectedTaskId = task.id;
    mergeTask(task);
    panel.classList.remove("collapsed");
    toggle.setAttribute("aria-expanded", "true");
    $("#prompt").value = "";
    $("#form-hint").textContent = "任务已交给 Codex，结果会自动出现。";
    $("#output-area").scrollIntoView({ behavior:"smooth", block:"start" });
  } catch(error) {
    const message = error.message || "任务没有提交成功。";
    setFormError(message);
    $("#form-hint").textContent = "提交失败，请重试。";
    addActivity({ type:"error", text:message, at:new Date().toISOString() });
  } finally {
    button.disabled = false;
    button.textContent = "开始任务";
  }
});

$("#copy-output").addEventListener("click", async () => {
  const output = $("#task-output").textContent;
  try {
    await navigator.clipboard.writeText(output);
    $("#copy-output").textContent = "已复制";
    setTimeout(() => { $("#copy-output").textContent = "复制"; }, 1200);
  } catch {
    $("#copy-output").textContent = "复制失败";
  }
});

toggle.addEventListener("click", () => {
  const collapsed = panel.classList.toggle("collapsed");
  toggle.setAttribute("aria-expanded", String(!collapsed));
});

async function boot() {
  if (matchMedia("(max-width:760px), (max-height:520px)").matches) panel.classList.add("collapsed");
  try {
    const [health, history] = await Promise.all([api("api/health"), api("api/tasks")]);
    modelLabel = health.model?.displayName || health.model?.id || "Codex";
    $("#workspace-name").textContent = health.workspace;
    setConnection(health.ready);
    for (const task of history.tasks) mergeTask(task);
    render();
  } catch(error) {
    $("#connection-text").textContent = "连接失败";
    $("#signal").className = "signal offline";
    addActivity({ type:"error", text:error.message, at:new Date().toISOString() });
  }
}

const stream = new EventSource("api/events");
stream.addEventListener("update", (message) => {
  const data = JSON.parse(message.data);
  if (data.type === "service") {
    modelLabel = data.model?.displayName || data.model?.id || modelLabel;
    setConnection(data.status === "ready");
    if (data.detail) addActivity({ type:"service", text:data.detail, at:data.at });
  }
  if (data.type === "task") {
    mergeTask(data.task);
    if (data.event) addActivity(data.event);
  }
  if (data.type === "event" || data.type === "approval") addActivity({ type:data.type, text:data.detail || data.event?.text || data.method, at:data.at || data.event?.at });
});
stream.onerror = () => setConnection(false);
window.addEventListener("visibilitychange", () => { if (!document.hidden) refreshTasks(); });
setInterval(refreshTasks, 4000);
boot();
