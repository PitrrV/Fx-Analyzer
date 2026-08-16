/**
 * Command Deck — klientská vrstva.
 *
 * UI nedrží vlastní stav agenta. Jediný zdroj pravdy je server: úvodní snímek
 * z /api/state a potom proud událostí z /api/stream. Cokoli se objeví na
 * obrazovce, přišlo z busu.
 *
 * Zobrazuje se pouze bezpečná telemetrie — stav, jméno nástroje, průběh úkolu
 * a výsledek. Interní reasoning modelu se sem vědomě neposílá ani nevykresluje.
 */

const $ = (id) => document.getElementById(id);

const el = {
  stage: $("coreStage"),
  state: $("coreState"),
  hint: $("coreHint"),
  brandMark: $("brandMark"),
  name: $("assistantName"),
  providerChip: $("providerChip"),
  voiceChip: $("voiceChip"),
  stream: $("stream"),
  composer: $("composer"),
  input: $("input"),
  sendBtn: $("sendBtn"),
  micBtn: $("micBtn"),
  systemInfo: $("systemInfo"),
  toolList: $("toolList"),
  taskList: $("taskList"),
  activity: $("activity"),
  confirmOverlay: $("confirmOverlay"),
  confirmQuestion: $("confirmQuestion"),
  confirmPayload: $("confirmPayload"),
  approveBtn: $("approveBtn"),
  denyBtn: $("denyBtn"),
  settingsBtn: $("settingsBtn"),
  settingsOverlay: $("settingsOverlay"),
  settingsBody: $("settingsBody"),
  closeSettingsBtn: $("closeSettingsBtn"),
};

const HINTS = {
  IDLE: "připraven",
  LISTENING: "poslouchám",
  THINKING: "rozumím požadavku",
  WORKING: "používám nástroje",
  SPEAKING: "odpovídám",
  ERROR: "něco se pokazilo",
};

const ui = {
  snapshot: null,
  tasks: new Map(),
  streamingBubble: null,
  activeConfirm: null,
};

// ── Boot ───────────────────────────────────────────────────────

init();

async function init() {
  await loadSnapshot();
  connectStream();
  wireEvents();
}

async function loadSnapshot() {
  const snap = await fetch("/api/state").then((r) => r.json());
  ui.snapshot = snap;

  const name = snap.config.assistant.name;
  document.title = `${name} · Command Deck`;
  el.name.textContent = name;
  el.brandMark.textContent = (snap.config.assistant.shortName || name[0] || "J").toUpperCase();

  renderProvider(snap.models);
  renderVoice(snap.voice);
  renderSystem(snap);
  renderTools(snap.tools);
  snap.tasks.forEach(upsertTask);
  snap.pendingConfirmations.forEach(showConfirm);
  setState(snap.state);
}

function connectStream() {
  const source = new EventSource("/api/stream");
  source.onmessage = (e) => handleEvent(JSON.parse(e.data));
  source.onerror = () => {
    setState("ERROR");
    el.hint.textContent = "spojení se serverem přerušeno";
  };
}

function wireEvents() {
  el.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    send();
  });

  el.approveBtn.addEventListener("click", () => resolveConfirm(true));
  el.denyBtn.addEventListener("click", () => resolveConfirm(false));

  el.settingsBtn.addEventListener("click", () => {
    renderSettings();
    el.settingsOverlay.hidden = false;
  });
  el.closeSettingsBtn.addEventListener("click", () => {
    el.settingsOverlay.hidden = true;
  });

  el.micBtn.addEventListener("click", () => {
    log(
      ui.snapshot?.voice?.enabled
        ? "Hlas je zapnutý, ale STT/TTS převodníky zatím nejsou implementované."
        : "Hlasový vstup je vypnutý — zapni features.voice v jarvis.config.json.",
      "warn",
    );
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") el.settingsOverlay.hidden = true;
    if (e.key === "/" && document.activeElement !== el.input) {
      e.preventDefault();
      el.input.focus();
    }
  });
}

// ── Události ze serveru ────────────────────────────────────────

function handleEvent(evt) {
  switch (evt.type) {
    case "state":
      setState(evt.state);
      break;

    case "message":
      ui.streamingBubble = null;
      addMessage(evt.role, evt.text);
      break;

    case "delta":
      appendDelta(evt.text);
      break;

    case "tool":
      markTool(evt.name, evt.status);
      log(`${evt.name} · ${evt.status}${evt.summary ? ` — ${evt.summary}` : ""}`, toneForTool(evt.status));
      break;

    case "task":
      upsertTask(evt);
      break;

    case "log":
      log(evt.text, evt.level);
      break;

    case "confirm_request":
      showConfirm(evt);
      break;

    case "confirm_resolved":
      if (ui.activeConfirm?.id === evt.id) hideConfirm();
      log(evt.approved ? "Akce potvrzena." : `Akce zamítnuta${evt.reason ? ` (${evt.reason})` : ""}.`, evt.approved ? "info" : "warn");
      break;
  }
}

const toneForTool = (status) => (status === "ok" ? "ok" : status === "running" ? "info" : "error");

// ── Centrální jádro ────────────────────────────────────────────

function setState(state) {
  el.stage.dataset.state = state;
  document.documentElement.dataset.state = state;
  el.state.textContent = state;
  el.hint.textContent = HINTS[state] ?? "";
  const busy = state !== "IDLE" && state !== "ERROR";
  el.sendBtn.disabled = busy;
  el.input.disabled = busy;
  if (!busy) el.input.focus();
}

// ── Konverzace ─────────────────────────────────────────────────

function send() {
  const text = el.input.value.trim();
  if (!text) return;
  el.input.value = "";

  fetch("/api/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  })
    .then((r) => (r.ok ? null : r.json().then((b) => log(b.error ?? "Požadavek odmítnut.", "error"))))
    .catch((err) => log(err.message, "error"));
}

function addMessage(role, text) {
  el.stream.querySelector(".empty")?.remove();

  const node = document.createElement("div");
  node.className = `msg ${role}`;
  node.innerHTML = `<span class="msg-role">${role === "user" ? "uživatel" : ui.snapshot?.config.assistant.name ?? "agent"}</span>`;

  const body = document.createElement("div");
  body.className = "msg-body";
  body.textContent = text;
  node.append(body);

  el.stream.append(node);
  el.stream.scrollTop = el.stream.scrollHeight;
  return body;
}

/** Průběžné vykreslování odpovědi, jak ji model streamuje. */
function appendDelta(text) {
  if (!ui.streamingBubble) ui.streamingBubble = addMessage("assistant", "");
  ui.streamingBubble.textContent += text;
  el.stream.scrollTop = el.stream.scrollHeight;
}

// ── Panely ─────────────────────────────────────────────────────

function renderProvider({ provider, degraded, roles }) {
  el.providerChip.className = `chip ${degraded ? "warn" : "live"}`;
  el.providerChip.querySelector("span").textContent = degraded
    ? `${provider} · degradovaný`
    : `${provider} · ${roles.primary.model}`;
}

function renderVoice(voice) {
  el.voiceChip.className = `chip ${voice.enabled ? "warn" : "off"}`;
  el.voiceChip.querySelector("span").textContent = voice.enabled ? "hlas · připravuje se" : "hlas · vypnuto";
  el.micBtn.classList.toggle("ready", Boolean(voice.enabled));
}

function renderSystem(snap) {
  const rows = [
    ["model", snap.models.provider],
    ["primary", snap.models.roles.primary.model],
    ["fast", snap.models.roles.fast.model],
    ["nástroje", `${snap.tools.filter((t) => t.enabled).length}/${snap.tools.length}`],
    ["paměť", `${snap.memory.longTerm.count} faktů`],
    ["konverzace", `${snap.memory.shortTerm.turns}/${snap.memory.shortTerm.maxTurns}`],
    ["kořeny", snap.config.security.allowedRoots.join(", ")],
    ["max kroků", snap.config.security.maxToolCallsPerTurn],
  ];

  el.systemInfo.innerHTML = rows
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${escape(String(v))}</dd></div>`)
    .join("");
}

function renderTools(tools) {
  el.toolList.innerHTML = tools
    .map(
      (t) => `
      <li class="tool ${t.enabled ? "on" : "off"}" data-tool="${escape(t.name)}">
        <div class="tool-head"><span class="tool-dot"></span><span class="tool-name">${escape(t.name)}</span></div>
        <div class="tool-perm">${escape(t.permissions)}</div>
      </li>`,
    )
    .join("");
}

/** Krátké zvýraznění nástroje, který právě běží. */
function markTool(name, status) {
  const node = el.toolList.querySelector(`[data-tool="${CSS.escape(name)}"]`);
  if (!node) return;
  node.classList.toggle("active", status === "running");
  if (status !== "running") setTimeout(() => node.classList.remove("active"), 600);
}

function upsertTask(task) {
  ui.tasks.set(task.id, task);
  el.taskList.querySelector(".empty")?.remove();

  const tasks = [...ui.tasks.values()].reverse().slice(0, 12);
  el.taskList.innerHTML = tasks
    .map(
      (t) => `
      <li class="task ${t.status}">
        <div class="task-title">${escape(t.title)}</div>
        <div class="task-meta">${t.status}${t.summary ? ` · ${escape(t.summary)}` : ""}</div>
        ${
          t.steps?.length
            ? `<ul class="task-steps">${t.steps.map((s) => `<li>${escape(s)}</li>`).join("")}</ul>`
            : ""
        }
      </li>`,
    )
    .join("");
}

function log(text, level = "info") {
  el.activity.querySelector(".empty")?.remove();

  const li = document.createElement("li");
  li.className = `act-${level === "info" ? "info" : level}`;
  li.innerHTML = `<span class="act-time">${new Date().toLocaleTimeString("cs-CZ", { hour12: false })}</span>`;

  const body = document.createElement("span");
  body.className = "act-text";
  body.textContent = text;
  li.append(body);

  el.activity.prepend(li);
  while (el.activity.children.length > 80) el.activity.lastElementChild.remove();
}

// ── Potvrzení nevratné akce ────────────────────────────────────

function showConfirm(payload) {
  ui.activeConfirm = payload;
  el.confirmQuestion.textContent = payload.question;
  el.confirmPayload.textContent = `${payload.tool}\n\n${JSON.stringify(payload.input, null, 2)}`;
  el.confirmOverlay.hidden = false;
  el.denyBtn.focus();
}

function hideConfirm() {
  ui.activeConfirm = null;
  el.confirmOverlay.hidden = true;
}

function resolveConfirm(approve) {
  const pending = ui.activeConfirm;
  if (!pending) return;
  hideConfirm();

  fetch("/api/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: pending.id, approve }),
  }).catch((err) => log(err.message, "error"));
}

// ── Nastavení ──────────────────────────────────────────────────

function renderSettings() {
  const c = ui.snapshot.config;
  const rows = [
    ["jméno asistenta", c.assistant.name],
    ["aktivační slovo", c.assistant.wakeWord],
    ["jazyk", c.assistant.language],
    ["poskytovatel", ui.snapshot.models.provider + (ui.snapshot.models.degraded ? " (degradovaný)" : "")],
    ...Object.entries(ui.snapshot.models.roles).map(([role, r]) => [`model · ${role}`, r.model]),
    ["nástroje", c.features.tools ? "zapnuto" : "vypnuto"],
    ["paměť", c.features.memory ? "zapnuto" : "vypnuto"],
    ["hlas", c.features.voice ? "zapnuto" : "vypnuto"],
    ["streaming", c.features.streaming ? "zapnuto" : "vypnuto"],
    ["povolené kořeny", c.security.allowedRoots.join(", ")],
    ["potvrzovat nevratné akce", c.security.confirmDestructive ? "ano" : "ne"],
    ["max volání nástrojů / tah", c.security.maxToolCallsPerTurn],
    ["zapnuté nástroje", ui.snapshot.tools.filter((t) => t.enabled).map((t) => t.name).join(", ") || "žádné"],
  ];

  el.settingsBody.innerHTML = rows
    .map(([k, v]) => `<div class="setting"><span>${escape(k)}</span><span>${escape(String(v))}</span></div>`)
    .join("");
}

function escape(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
