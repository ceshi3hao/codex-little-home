const taskForm = document.querySelector("#task-form");
const promptField = document.querySelector("#prompt");
const startButton = document.querySelector("#start-button");
const taskList = document.querySelector("#task-list");
const taskCount = document.querySelector("#task-count");
const eventFeed = document.querySelector("#event-feed");
const scene = document.querySelector("#scene");
const sceneState = document.querySelector("#scene-state");
const sceneCopy = document.querySelector("#scene-copy");
const screenStatus = document.querySelector("#screen-status");
const screenDetail = document.querySelector("#screen-detail");
const connectionText = document.querySelector("#connection-text");
const signal = document.querySelector("#signal");
const workspaceName = document.querySelector("#workspace-name");
const stateTag = document.querySelector("#state-tag");
const formHint = document.querySelector("#form-hint");
const tasks = new Map();
const activity = [];

const activeStates = new Set(["inProgress", "starting", "interrupting"]);
const visualStates = {
  idle: ["idle", "安静待命", "准备接收任务", "待命", "准备接收任务"],
  working: ["working", "正在工作", "Codex 正在分析、编辑或运行测试。", "工作中", "任务正在进行"],
  done: ["done", "任务完成", "这次工作已经写入记录。", "完成", "任务已完成"],
  blocked: ["blocked", "需要处理", "任务结束前遇到了阻塞。", "受阻", "查看事件记录"]
};

function setVisualState(name) {
  const [sceneMode, label, copy, monitor, detail] = visualStates[name] || visualStates.idle;
  scene.dataset.status = sceneMode;
  sceneState.textContent = label;
  sceneCopy.textContent = copy;
  screenStatus.textContent = monitor;
  screenDetail.textContent = detail;
  stateTag.textContent = monitor;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "刚刚" : date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function statusClass(status) {
  if (status === "completed") return "completed";
  if (["failed", "interrupted"].includes(status)) return "failed";
  return "";
}

function renderTasks() {
  const list = [...tasks.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  taskCount.textContent = String(list.length);
  taskList.replaceChildren();
  if (!list.length) {
    const message = document.createElement("p");
    message.className = "empty-state";
    message.textContent = "还没有任务。";
    taskList.append(message);
    return;
  }
  for (const task of list) {
    const node = document.querySelector("#task-template").content.firstElementChild.cloneNode(true);
    node.querySelector(".task-prompt").textContent = task.prompt;
    node.querySelector("time").textContent = formatTime(task.updatedAt || task.createdAt);
    const status = node.querySelector(".task-status");
    status.textContent = task.status;
    status.classList.add(statusClass(task.status));
    const stopButton = node.querySelector(".stop-button");
    stopButton.hidden = !activeStates.has(task.status);
    stopButton.addEventListener("click", () => stopTask(task.id, stopButton));
    taskList.append(node);
  }
  const newest = list[0];
  if (activeStates.has(newest.status)) setVisualState("working");
  else if (newest.status === "completed") setVisualState("done");
  else if (["failed", "interrupted"].includes(newest.status)) setVisualState("blocked");
  else setVisualState("idle");
}

function addActivity(entry) {
  if (!entry?.text) return;
  const last = activity.at(-1);
  if (last && last.text === entry.text && last.type === entry.type) return;
  activity.push(entry);
  while (activity.length > 80) activity.shift();
  eventFeed.replaceChildren();
  for (const item of [...activity].reverse()) {
    const node = document.querySelector("#event-template").content.firstElementChild.cloneNode(true);
    node.querySelector("time").textContent = formatTime(item.at);
    node.querySelector("span").textContent = item.text;
    eventFeed.append(node);
  }
}

function mergeTask(task) {
  if (!task?.id) return;
  tasks.set(task.id, task);
  for (const event of task.events || []) addActivity(event);
  renderTasks();
}

async function request(path, options) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败。");
  return data;
}

async function stopTask(id, button) {
  button.disabled = true;
  try {
    const data = await request(`api/tasks/${id}/interrupt`, { method: "POST" });
    mergeTask(data.task);
  } catch (error) {
    addActivity({ type: "error", text: error.message, at: new Date().toISOString() });
    button.disabled = false;
  }
}

taskForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = promptField.value.trim();
  if (!prompt) return promptField.focus();
  startButton.disabled = true;
  startButton.textContent = "正在交给 Codex";
  formHint.textContent = "正在建立任务线程...";
  try {
    const data = await request("api/tasks", { method: "POST", body: JSON.stringify({ prompt }) });
    mergeTask(data.task);
    promptField.value = "";
    formHint.textContent = "任务已交给 Codex。";
  } catch (error) {
    formHint.textContent = error.message;
    addActivity({ type: "error", text: error.message, at: new Date().toISOString() });
  } finally {
    startButton.disabled = false;
    startButton.textContent = "开始任务";
  }
});

async function bootstrap() {
  try {
    const [health, history] = await Promise.all([request("api/health"), request("api/tasks")]);
    workspaceName.textContent = health.workspace;
    connectionText.textContent = health.ready ? "已连接本机 Codex" : "正在唤醒本机 Codex";
    signal.className = `signal ${health.ready ? "online" : ""}`;
    for (const task of history.tasks) mergeTask(task);
    if (!history.tasks.length) setVisualState("idle");
  } catch (error) {
    connectionText.textContent = "连接失败";
    signal.className = "signal offline";
    addActivity({ type: "error", text: error.message, at: new Date().toISOString() });
  }
}

const events = new EventSource("api/events");
events.addEventListener("update", (message) => {
  const data = JSON.parse(message.data);
  if (data.type === "service") {
    const online = data.status === "ready";
    connectionText.textContent = online ? "已连接本机 Codex" : "正在唤醒本机 Codex";
    signal.className = `signal ${online ? "online" : "offline"}`;
    if (data.detail) addActivity({ type: "service", text: data.detail, at: data.at });
  }
  if (data.type === "task") {
    mergeTask(data.task);
    if (data.event) addActivity(data.event);
  }
  if (data.type === "event" || data.type === "approval") addActivity({ text: data.detail || data.event?.text || data.method, type: data.type, at: data.at || data.event?.at });
});
events.onerror = () => {
  connectionText.textContent = "正在重连";
  signal.className = "signal offline";
};

bootstrap();
