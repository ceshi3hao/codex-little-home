import * as THREE from "./room/vendor/three.module.js";
import { createWorld } from "./room/world.js";

const canvas = document.querySelector("#scene");
const television = document.querySelector("#television-player");
const lowPower = matchMedia("(pointer: coarse)").matches || devicePixelRatio > 2;
const captureMode = new URLSearchParams(location.search).has("shot");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !lowPower, powerPreference: "high-performance", preserveDrawingBuffer: captureMode });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, lowPower ? 1 : 1.35));
renderer.shadowMap.enabled = !lowPower;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const world = createWorld(renderer, { quality: lowPower ? "low" : "balanced" });
world.setLabelsVisible(false);
const camera = new THREE.PerspectiveCamera(40, 1, .08, 120);
const target = new THREE.Vector3(6.4, .65, 4.2);
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const clock = new THREE.Clock();
const presets = {
  overview: { yaw: .72, pitch: .93, radius: 19.2, target: [6.4, .62, 4.15] },
  desk: { yaw: -.79, pitch: .76, radius: 7.7, target: [9.5, .78, 3.1] },
  living: { yaw: .22, pitch: .70, radius: 8.6, target: [6.2, .68, 4.15] }
};
let yaw = presets.overview.yaw;
let pitch = presets.overview.pitch;
let radius = presets.overview.radius;
let dragging = false;
let lastPointer;
let downPointer;
let lastEnvironmentMinute = -1;
let roomState = { mode: "idle", title: "安静待命", task: null };
let manualMode = "idle";

function placeCamera() {
  const sin = Math.sin(pitch);
  camera.position.set(target.x + radius * sin * Math.sin(yaw), target.y + radius * Math.cos(pitch), target.z + radius * sin * Math.cos(yaw));
  camera.lookAt(target);
  world.updateCutaway(camera.position, target, true);
}

function usePreset(name) {
  const next = presets[name] || presets.overview;
  yaw = next.yaw;
  pitch = next.pitch;
  radius = next.radius;
  target.set(...next.target);
  placeCamera();
  document.querySelectorAll("[data-camera]").forEach((button) => button.classList.toggle("active", button.dataset.camera === name));
}

function updateSize() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.shadowMap.needsUpdate = true;
}

function currentSceneMode() {
  return roomState.mode === "working" ? "desk" : manualMode;
}

function syncScene() {
  const mode = currentSceneMode();
  const task = roomState.task;
  const prompt = task?.prompt ? task.prompt.replace(/\s+/g, " ").slice(0, 26) : mode === "tv" ? "客厅电视播放中" : mode === "desk" ? "书桌正在敲代码" : "等待任务";
  world.setMemoryNotes(["CODEX 小窝", roomState.title || "待命", prompt]);
  world.setResidentMode(mode);
  world.setScreenState("desk", mode === "desk");
  world.setScreenState("tv", mode === "tv");
  document.querySelectorAll("[data-action]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.action === (mode === "tv" ? "watch" : mode === "desk" ? "code" : "rest"))));
}

function updateEnvironment() {
  const date = new Date();
  const minute = date.getHours() * 60 + date.getMinutes();
  if (minute === lastEnvironmentMinute) return;
  lastEnvironmentMinute = minute;
  const mode = currentSceneMode();
  world.updateEnvironment({ hour: date.getHours() + date.getMinutes() / 60, lamp: true, kind: mode === "tv" ? "tv" : mode === "desk" ? "desk" : "idle" });
  renderer.shadowMap.needsUpdate = true;
}

function render() {
  const delta = Math.min(clock.getDelta(), .05);
  world.updateResident(delta, clock.elapsedTime);
  updateEnvironment();
  renderer.render(world.scene, camera);
  requestAnimationFrame(render);
}

async function useAction(action) {
  if (action === "watch") {
    manualMode = "tv";
    world.setTVVideo(television);
    television.muted = false;
    try { await television.play(); } catch { television.muted = true; await television.play().catch(() => {}); }
    usePreset("living");
  } else if (action === "code") {
    manualMode = "desk";
    television.pause();
    usePreset("desk");
  } else {
    manualMode = "idle";
    television.pause();
    usePreset("overview");
  }
  syncScene();
  updateEnvironment();
}

function hotspotAction(event) {
  const rect = canvas.getBoundingClientRect();
  pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(world.hotspots, false)[0]?.object?.userData?.hotspot;
  if (!hit) return;
  if (hit.spot === "tv" || hit.spot === "sofa") useAction("watch");
  if (hit.spot === "desk") useAction("code");
}

const pointers = new Map();
let pinchDistance = 0;
function pointerDistance() { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); }
canvas.addEventListener("pointerdown", (event) => {
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  dragging = true;
  lastPointer = { x: event.clientX, y: event.clientY };
  downPointer = { x: event.clientX, y: event.clientY };
  if (pointers.size === 2) pinchDistance = pointerDistance();
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add("dragging");
});
canvas.addEventListener("pointermove", (event) => {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 2) {
    const next = pointerDistance();
    radius = THREE.MathUtils.clamp(radius + (pinchDistance - next) * .016, 5.4, 24);
    pinchDistance = next;
    placeCamera();
    return;
  }
  if (!dragging || !lastPointer) return;
  yaw -= (event.clientX - lastPointer.x) * .008;
  pitch = THREE.MathUtils.clamp(pitch + (event.clientY - lastPointer.y) * .008, .28, 1.33);
  lastPointer = { x: event.clientX, y: event.clientY };
  placeCamera();
});
function release(event) {
  const click = downPointer && Math.hypot(event.clientX - downPointer.x, event.clientY - downPointer.y) < 9 && pointers.size === 1;
  if (click) hotspotAction(event);
  pointers.delete(event.pointerId);
  dragging = pointers.size > 0;
  lastPointer = dragging ? [...pointers.values()][0] : null;
  if (pointers.size < 2) pinchDistance = 0;
  if (!dragging) canvas.classList.remove("dragging");
}
canvas.addEventListener("pointerup", release);
canvas.addEventListener("pointercancel", release);
canvas.addEventListener("wheel", (event) => { event.preventDefault(); radius = THREE.MathUtils.clamp(radius + event.deltaY * .012, 5.4, 24); placeCamera(); }, { passive: false });
canvas.addEventListener("keydown", (event) => { if (event.key === "Escape") useAction("rest"); });
document.querySelectorAll("[data-camera]").forEach((button) => button.addEventListener("click", () => usePreset(button.dataset.camera)));
document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => useAction(button.dataset.action)));
document.querySelector("#reset-camera").addEventListener("click", () => usePreset("overview"));
window.addEventListener("codex-home:update", (event) => { roomState = event.detail; syncScene(); updateEnvironment(); });
new ResizeObserver(updateSize).observe(canvas);
world.setTVVideo(television);
usePreset("overview");
syncScene();
updateSize();
render();
