/* ============================================================
   AI Studio - browser app
   Handles: chat with opencode, live thinking display, animated
   ComfyUI workflow graph, asset upload, results gallery.
   ============================================================ */
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  es: null,
  sessionId: null,
  attached: [],          // files staged for the next message
  busy: false,
  graph: null,           // litegraph workflow currently displayed
  graphFile: null,
  nodeEls: new Map(),
  runNodes: {},           // nodeID -> {state,value,max}
  steps: [],
  results: [],
  assets: [],
  lastRender: 0,
  previewPoll: null,
  pendingPerm: null,      // permission request waiting on the human
  activeProject: "",      // project folder this conversation belongs to
  projects: [],
};

const NODE_TITLES = {
  CheckpointLoaderSimple: "Load model",
  DualCLIPLoader: "Load text encoders",
  CLIPVisionLoader: "Load vision model",
  LoadFramePackModel: "Load FramePack model",
  DownloadAndLoadFramePackModel: "Download FramePack model",
  LoadFramePackModelGguf: "Load FramePack GGUF",
  CLIPTextEncode: "Write prompt",
  CLIPVisionEncode: "Encode image",
  EmptyLatentImage: "Create blank canvas",
  KSampler: "Paint the image (sampling)",
  FramePackSampler: "Paint frames (sampling)",
  VAEDecode: "Turn noise into a picture",
  VAEDecodeTiled: "Turn noise into a picture",
  VAEEncode: "Read picture into latent",
  SaveImage: "Save the picture",
  SaveVideo: "Save the video",
  VHS_VideoCombine: "Combine frames into video",
  LoadImage: "Your uploaded photo",
  ControlNetLoader: "Load pose control",
  ControlNetApplyAdvanced: "Apply pose control",
  LoadImageMask: "Load mask",
  CheckpointLoaderSimple: "Load model",
  LTXVImgToVideo: "Turn photo into video",
  LTXVConditioning: "Set video motion",
  KSamplerSelect: "Choose sampler",
  SamplerCustom: "Sample",
  GetImageSizeAndCount: "Measure image size",
  ImageResizePlus: "Resize image",
  ImageResize: "Resize image",
  FramePackFindNearestBucket: "Match video size",
  CLIPVisionEncode: "Encode image for vision",
  ConditioningZeroOut: "Empty conditioning",
  VAELoader: "Load VAE",
  TextEncodeLTXV: "Describe the motion",
  ModelSamplingLTXV: "Video model settings",
  LTXVAddGuide: "Add reference frame",
  EmptyLTXVLatentVideo: "Blank video canvas",
  Note: "Note (ignored)",
  MarkdownNote: "Note (ignored)",
  GetNode: "Reuse a value",
  SetNode: "Store a value",
  LoraLoader: "Apply style (LoRA)",
};

const EXPLAIN = {
  CheckpointLoaderSimple: "Loading the AI model into memory.",
  CLIPTextEncode: "Turning your words into numbers the AI understands.",
  EmptyLatentImage: "Creating a blank canvas at the requested size.",
  KSampler: "Drawing the image one step at a time — this is the slow part.",
  VAEDecode: "Converting the internal data into a viewable picture.",
  SaveImage: "Writing the finished file to disk.",
  LoadImage: "Reading your uploaded photo.",
  ControlNetApply: "Forcing the output to follow the pose from your photo.",
  DWPose: "Detecting the skeleton/pose in your photo.",
  FramePackSampler: "Generating the video frame by frame.",
  VHS_VideoCombine: "Stitching the frames into a video file.",
  SaveVideo: "Writing the finished video to disk.",
  LTXVImgToVideo: "Using your photo as the first frame of a video.",
  LTXVConditioning: "Setting how fast and far the motion should go.",
};

/* ================= utility ================= */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function md(s) {
  let t = esc(s);
  t = t.replace(/```([\s\S]*?)```/g, (_, c) => `<pre>${c.trim()}</pre>`);
  t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/^### (.*)$/gm, "<strong>$1</strong>").replace(/^## (.*)$/gm, "<strong>$1</strong>").replace(/^# (.*)$/gm, "<strong>$1</strong>");
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return t;
}
function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = msg;
  $("#toast-host").appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = ".4s"; setTimeout(() => el.remove(), 420); }, kind === "err" ? 5200 : 3200);
}
function step(text, kind = "") {
  const li = document.createElement("li");
  if (kind) li.className = kind;
  li.innerHTML = `${esc(text)}<span class="st-time">${new Date().toLocaleTimeString()}</span>`;
  $("#steps-list").prepend(li);
  state.steps.unshift({ text, kind });
  $("#tab-results") && ($(".side-empty") ? null : null);
  const empty = $("#steps-list").parentElement.querySelector(".side-empty");
  if (empty) empty.classList.add("hidden");
}

/* ================= services / status ================= */
async function loadStatus() {
  try {
    const s = await (await fetch("/api/status")).json();
    setSvc("svc-opencode", s.opencode && s.opencode.connected);
    setSvc("svc-comfyui", s.comfy && s.comfy.connected);
    setSvc("svc-ollama", s.ollama && s.ollama.connected);

    const gpu = $("#svc-gpu");
    if (s.comfy && s.comfy.connected) {
      gpu.classList.add("on"); gpu.classList.remove("off");
      const short = (s.comfy.gpu || "").replace("cuda:0 ", "").replace(" Laptop GPU", "").split(":")[0];
      $("#gpu-lbl").textContent = `${short} · ${s.comfy.vramFreeGB ?? "?"}G free`;
      gpu.title = `${s.comfy.gpu}\nVRAM free: ${s.comfy.vramFreeGB} GB\nVersion: ${s.comfy.version}`;
    } else { gpu.classList.add("off"); gpu.classList.remove("on"); }

    if (s.model) state.model = s.model;
    fillModels(s.models || [], s.model);

    const ap = s.activeProject || "";
    if (ap !== state.activeProject) { state.activeProject = ap; renderProjectChip(); }

    if (!s.opencode.connected) {
      $("#session-hint").textContent = "AI offline";
      setTimeout(loadStatus, 5000);
    } else if (!state.sessionId) {
      ensureSession();
    }
  } catch (e) {
    $("#session-hint").textContent = "backend offline";
    setTimeout(loadStatus, 4000);
  }
}
function setSvc(id, on) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle("on", !!on);
  el.classList.toggle("off", !on);
}
function fillModels(models, current) {
  const sel = $("#model-pick");
  if (sel.dataset.filled === String(models.length)) return;
  sel.dataset.filled = String(models.length);
  const active = models.filter((m) => m.status === "active");
  const groups = { "opencode": [], "ollama": [] };
  for (const m of active) (groups[m.providerID] ? groups[m.providerID] : (groups[m.providerID] = [])).push(m);
  sel.innerHTML = "";
  const mk = (label, list) => {
    if (!list.length) return;
    const og = document.createElement("optgroup");
    og.label = label;
    for (const m of list) {
      const o = document.createElement("option");
      o.value = `${m.providerID}|${m.id}`;
      o.textContent = m.name || m.id;
      og.appendChild(o);
    }
    sel.appendChild(og);
  };
  mk("Free cloud AI", groups["opencode"] || []);
  mk("Runs on your PC (Ollama)", groups["ollama"] || []);
  if (current) sel.value = `${current.providerID}|${current.modelID}`;
}

async function ensureSession() {
  try {
    const r = await (await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
    state.sessionId = r.sessionId;
    $("#session-hint").textContent = "connected";
    if (r.model && $("#model-pick")) $("#model-pick").value = `${r.model.providerID}|${r.model.modelID}`;
    loadHistory();
  } catch (e) {
    $("#session-hint").textContent = "cannot reach AI";
    setTimeout(ensureSession, 4000);
  }
}

async function loadHistory() {
  try {
    const h = await (await fetch("/api/messages")).json();
    if (!h.messages || !h.messages.length) return;
    $("#welcome").classList.add("hidden");
    for (const m of h.messages.slice().reverse()) {
      if (m.type === "user") addMsg("user", m.text);
      else if (m.type === "assistant") {
        const txt = (m.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n") || m.text;
        if (txt) addMsg("ai", txt, m.error ? m.error.message : null);
      }
    }
  } catch {}
}

/* ================= chat ================= */
function addMsg(who, text, err) {
  $("#welcome").classList.add("hidden");
  const d = document.createElement("div");
  d.className = "msg " + (who === "user" ? "user" : "ai");
  d.innerHTML = `<div class="who">${who === "user" ? "You" : "AI"}</div><div class="bubble">${md(text)}</div>`;
  if (err) d.querySelector(".bubble").insertAdjacentHTML("beforeend", `<div class="err">&#9888; ${esc(err)}</div>`);
  $("#messages").appendChild(d);
  scrollChat();
  return d;
}
function scrollChat() {
  const el = $("#chat-scroll");
  el.scrollTop = el.scrollHeight;
}

/* ---- live card: reasoning / tools / text ---- */
const liveBlocks = new Map();
function liveShow(title) {
  $("#live-card").classList.remove("hidden");
  $("#live-title").textContent = title || "Working…";
  scrollChat();
}
function liveHide() {
  $("#live-card").classList.add("hidden");
  liveBlocks.clear();
  $("#live-blocks").innerHTML = "";
}
function liveBlock(key, kind, head, body) {
  let el = liveBlocks.get(key);
  if (!el) {
    el = document.createElement("div");
    el.className = "lblock " + kind;
    el.innerHTML = `<div class="lb-h">${esc(head)}</div><div class="lb-b"></div>`;
    $("#live-blocks").appendChild(el);
    liveBlocks.set(key, el);
  }
  el.querySelector(".lb-h").textContent = head;
  el.querySelector(".lb-b").textContent = body;
  const box = $("#live-blocks");
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 90) box.scrollTop = box.scrollHeight;
}
function activity(text) { $("#act-text").textContent = text; }

/* ================= event stream (SSE) ================= */
function connectEvents() {
  const es = new EventSource("/api/events");
  state.es = es;

  es.addEventListener("service", (e) => {
    const d = JSON.parse(e.data).data;
    if (d.name === "opencode") setSvc("svc-opencode", d.state === "connected");
    if (d.name === "comfyui") setSvc("svc-comfyui", d.state === "connected");
  });

  es.addEventListener("opencode", (e) => {
    const d = JSON.parse(e.data).data;
    handleOpencode(d.type, d.data || {});
  });

  es.addEventListener("assistant_text", (e) => {
    const d = JSON.parse(e.data).data;
    if (d.text && d.text.trim()) {
      addMsg("ai", d.text);
      state.busy = false;
      liveHide();
      activity("Done.");
      step("AI replied", "ok");
    }
  });

  es.addEventListener("prompt_sent", () => {
    state.busy = true;
    liveShow("Thinking…");
    activity("Reading your message…");
  });

  es.addEventListener("session_recycled", (e) => {
    try {
      const d = JSON.parse(e.data).data;
      if (d.session) state.sessionId = d.session;
    } catch {}
    $("#messages").innerHTML = "";
    addMsg("ai", "Fresh conversation started — an old attachment couldn't be re-read, so I cleared the chat. Send your message again.");
    state.busy = false;
    liveHide();
  });

  es.addEventListener("projects_changed", () => loadProjects());

  es.addEventListener("agent_idle", () => {
    if (state.busy) { state.busy = false; liveHide(); }
  });

  es.addEventListener("comfy_queue", (e) => {
    const d = JSON.parse(e.data).data;
    const n = (d.queue_remaining || 0);
    if (n > 0 && !state.previewPoll) startPreviewPoll();
    if (n === 0) stopPreviewPoll();
  });

  es.addEventListener("comfy_run_start", async (e) => {
    const d = JSON.parse(e.data).data;
    step("Generator started" + (d.workflow ? ` (${d.workflow})` : ""), "run");
    $("#flow-progress").classList.remove("hidden");
    $("#prog-fill").style.width = "3%";
    $("#prog-label").textContent = "Loading models…";
    $("#prog-num").textContent = "";
    state.runNodes = {};
    if (d.graph) await showGraph(d.graph, d.workflow);
    else if (d.promptId) await loadGraphForRun();
    startPreviewPoll();
    fitGraph();
  });

  es.addEventListener("comfy_nodes", (e) => {
    const d = JSON.parse(e.data).data;
    state.runNodes = d || {};
    applyNodeStates();
  });

  es.addEventListener("comfy_progress", (e) => {
    const d = JSON.parse(e.data).data;
    const pct = d.max ? Math.round((d.value / d.max) * 100) : 0;
    $("#prog-fill").style.width = Math.max(4, pct) + "%";
    const title = nodeTitle(d.node);
    $("#prog-label").textContent = `${title}`;
    $("#prog-num").textContent = `${d.value} / ${d.max}`;
    $("#explain-text").textContent = explainFor(d.node, title);
    $("#flow-explain").classList.remove("hidden");
    state.runNodes[d.node] = { ...(state.runNodes[d.node] || {}), state: "running", value: d.value, max: d.max };
    applyNodeStates();
    highlightLinks(d.node, "active");
  });

  es.addEventListener("comfy_output", (e) => {
    const d = JSON.parse(e.data).data;
    for (const o of d.outputs || []) {
      const isVideo = /\.(mp4|webm|gif|mov)$/i.test(o.filename || "");
      const url = `/api/file?path=${encodeURIComponent(`D:\\ComfyUI_windows_portable\\ComfyUI\\output\\${o.subfolder ? o.subfolder + "\\" : ""}${o.filename}`)}`;
      addResult({ name: o.filename, url, video: isVideo, node: d.node });
      step(`Output created: ${o.filename}`, "ok");
    }
  });

  es.addEventListener("comfy_error", (e) => {
    const d = JSON.parse(e.data).data;
    const el = d.nodeId != null ? state.nodeEls.get(String(d.nodeId)) : null;
    if (el) { el.className = "node st-error"; }
    $("#prog-label").textContent = "Failed: " + (d.message || "unknown error").slice(0, 120);
    $("#prog-fill").style.background = "var(--err)";
    $("#flow-explain").classList.remove("hidden");
    $("#explain-text").textContent = (d.message || "") + (Array.isArray(d.details) ? " " + d.details.slice(-2).join(" ") : "");
    step("Generator error: " + (d.message || "unknown"), "err");
    toast("Generation failed — see Steps tab", "err");
  });

  es.addEventListener("comfy_run_end", (e) => {
    const d = JSON.parse(e.data).data;
    stopPreviewPoll();
    setTimeout(() => $("#flow-progress").classList.add("hidden"), 2600);
    $("#prog-fill").style.width = d.ok ? "100%" : $("#prog-fill").style.width;
    if (d.ok) {
      $("#prog-label").textContent = `Finished in ${(d.elapsed / 1000).toFixed(1)}s`;
      $("#prog-num").textContent = "✓";
      step("Generator finished" + (d.elapsed ? ` in ${(d.elapsed / 1000).toFixed(1)}s` : ""), "ok");
      toast("Done! Your result is in the Results tab.", "ok");
      $("#flow-preview").classList.add("hidden");
      setTimeout(loadResults, 700);
      setTimeout(loadResults, 2200);
    } else {
      step("Generator stopped", "err");
    }
  });

  es.addEventListener("asset_uploaded", (e) => {
    const a = JSON.parse(e.data).data;
    state.assets.unshift(a);
    renderAssets();
    toast(`Uploaded ${a.name}`, "ok");
  });

  es.addEventListener("permission_asked", (e) => {
    showPermission(JSON.parse(e.data).data);
  });
  es.addEventListener("permission_resolved", () => hidePermission());
  es.addEventListener("permission_auto", (e) => {
    const d = JSON.parse(e.data).data;
    const cmd = (d.resources || [])[0] || "command";
    step("Auto-approved: " + cmd, "ok");
  });

  es.addEventListener("comfy_preview", (e) => {
    const d = JSON.parse(e.data).data;
    if (!d.base64) return;
    const box = $("#flow-preview");
    box.classList.remove("hidden");
    box.innerHTML = `<img src="data:image/jpeg;base64,${d.base64}" alt=""><div class="pv-cap">live preview while drawing…</div>`;
  });

  es.onerror = () => setSvc("svc-opencode", false);
}

/* ---- permission gate ---- */
function showPermission(d) {
  if (!d || !d.id) return;
  state.pendingPerm = d;
  $("#perm-card").classList.remove("hidden");
  $("#perm-action").textContent = d.action || "permission";
  const ul = $("#perm-resources");
  ul.innerHTML = (d.resources || []).map((r) => `<li>${esc(r)}</li>`).join("");
  liveShow("Needs your permission");
  activity("Waiting for you to allow or reject…");
  step(`Permission requested: ${d.action}`, "");
  toast("The AI needs your permission — see the chat panel", "err");
}
function hidePermission() {
  $("#perm-card").classList.add("hidden");
  state.pendingPerm = null;
}
async function replyPermission(reply) {
  const d = state.pendingPerm;
  if (!d) return;
  hidePermission();
  try {
    const r = await fetch("/api/permissions/reply", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: d.id, reply }),
    });
    if (!r.ok) throw new Error(await r.text());
    step(`Permission ${reply === "reject" ? "rejected" : "allowed"}`, reply === "reject" ? "err" : "ok");
    if (reply === "reject") { state.busy = false; liveHide(); }
    else activity("Continuing…");
  } catch (e) {
    toast("Could not reply: " + e.message, "err");
    hidePermission();
  }
}

function handleOpencode(type, d) {
  const mid = d.assistantMessageID || "x";

  if (type === "session.next.step.started") {
    liveShow("Thinking…");
    activity("Planning how to do that…");
    step("AI started working", "run");
  }
  else if (type === "session.next.reasoning.started") {
    activity("Considering the options…");
    liveBlock(mid + ":reason", "reason", "Thinking", "");
  }
  else if (type === "session.next.reasoning.delta") {
    const prev = liveBlocks.get(mid + ":reason");
    const base = prev ? prev.querySelector(".lb-b").textContent : "";
    liveBlock(mid + ":reason", "reason", "Thinking", base + (d.text || ""));
    $("#live-title").textContent = "Thinking…";
  }
  else if (type === "session.next.text.started") {
    activity("Writing a reply…");
  }
  else if (type === "session.next.text.delta") {
    const prev = liveBlocks.get(mid + ":text");
    const base = prev ? prev.querySelector(".lb-b").textContent : "";
    liveBlock(mid + ":text", "text", "Reply", base + (d.text || ""));
    $("#live-title").textContent = "Replying…";
  }
  else if (type === "session.next.tool.input.started" || type === "session.next.tool.called") {
    const name = d.name || d.tool || "tool";
    activity(`Using tool: ${name}`);
    liveBlock(mid + ":tool:" + (d.callID || name), "tool", "Tool · " + name, summarizeTool(name, d.input));
    step(`Tool: ${friendlyTool(name)}`, "run");
  }
  else if (type === "session.next.tool.input.ended") {
    let inp = "";
    try { inp = d.text ? JSON.parse(d.text) : {}; } catch { inp = d.text || {}; }
    const key = mid + ":tool:" + (d.callID || "tool");
    const el = liveBlocks.get(key);
    const name = el ? (el.querySelector(".lb-h").textContent.replace("Tool · ", "")) : "tool";
    liveBlock(key, "tool", "Tool · " + name, summarizeTool(name, inp));
  }
  else if (type === "session.next.tool.success") {
    const key = mid + ":tool:" + (d.callID || "tool");
    const el = liveBlocks.get(key);
    if (el) {
      const name = el.querySelector(".lb-h").textContent.replace("Tool · ", "");
      const out = (d.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
      el.querySelector(".lb-h").textContent = `✓ ${name}`;
      el.querySelector(".lb-b").textContent = summarizeTool(name, null) + (out ? "\n→ " + out.slice(0, 400) : "");
    }
    step("Tool finished", "ok");
  }
  else if (type === "session.next.tool.failed") {
    const key = mid + ":tool:" + (d.callID || "tool");
    const el = liveBlocks.get(key);
    if (el) { el.classList.add("tool"); el.querySelector(".lb-h").textContent = "✗ tool failed"; }
    step("Tool failed", "err");
  }
  else if (type === "session.next.step.ended") {
    if (d.finish === "tool-calls") activity("Checking the result…");
  }
  else if (type === "session.next.model.switched") {
    if (d.model) {
      const lbl = `${d.model.providerID}/${d.model.id}`;
      $("#session-hint").textContent = lbl;
      step("AI model: " + d.model.id, "ok");
    }
  }
  else if (type === "session.next.error" || /error/.test(type)) {
    liveHide(); state.busy = false;
    step("AI error: " + JSON.stringify(d).slice(0, 160), "err");
  }
}

function friendlyTool(n) {
  return ({
    bash: "ran a command", edit: "edited a file", write: "wrote a file", read: "read a file",
    grep: "searched files", glob: "found files", webfetch: "opened a web page",
    comfyui_status: "checked the generator",
    comfyui_list_workflows: "listed available workflows",
    comfyui_describe_workflow: "inspected a workflow",
    comfyui_set_prompt: "set the text prompt",
    comfyui_set_image: "chose your photo",
    comfyui_run_workflow: "started the generator",
    comfyui_queue_status: "checked progress",
    comfyui_get_outputs: "collected results",
    comfyui_list_models: "checked installed models",
    comfyui_upload_reference: "copied your photo",
    task: "delegated a sub-task",
    todowrite: "updated the plan",
    question: "asked you a question",
  })[n] || n;
}
function summarizeTool(name, input) {
  const f = friendlyTool(name);
  if (!input) return f;
  const bits = [];
  if (typeof input === "string") return f + ": " + input.slice(0, 300);
  for (const k of ["workflow", "file", "filename", "positive", "text", "command", "path", "prompt", "sourcePath", "image", "seed", "steps"]) {
    if (input[k] != null) bits.push(`${k}=${String(input[k]).slice(0, 140)}`);
  }
  if (!bits.length) try { bits.push(JSON.stringify(input).slice(0, 220)); } catch {}
  return f + " · " + bits.join("  ");
}

/* ================= workflow canvas ================= */
async function loadWorkflows() {
  try {
    const r = await (await fetch("/api/workflows")).json();
    const sel = $("#workflow-pick");
    sel.innerHTML = "";
    for (const w of r.workflows) {
      if (w.error) continue;
      const o = document.createElement("option");
      o.value = w.file;
      o.textContent = `${w.family} · ${w.task} · ${w.nodes}n`;
      o.dataset.file = w.file;
      sel.appendChild(o);
    }
    // sensible default: a simple text-to-image workflow
    const prefer = r.workflows.find((w) => w.file === "SD15_Text2Img.json");
    if (prefer) sel.value = prefer.file;
    sel.onchange = () => loadGraph(sel.value);
    if (prefer) await loadGraph(prefer.file);
  } catch (e) { console.warn(e); }
}

async function loadGraph(file) {
  try {
    const g = await (await fetch("/api/workflow/graph?file=" + encodeURIComponent(file))).json();
    state.graphFile = file;
    await showGraph(g.graph, file);
    fitGraph();
  } catch (e) { console.warn(e); }
}

async function loadGraphForRun() {
  if (state.graphFile) await loadGraph(state.graphFile);
}

async function showGraph(graph, file) {
  state.graph = graph;
  state.graphFile = file || state.graphFile;
  state.nodeEls.clear();

  $("#flow-empty").classList.add("hidden");
  $("#flow-canvas").classList.remove("hidden");

  const nodesEl = $("#flow-nodes");
  const linksEl = $("#flow-links");
  nodesEl.innerHTML = "";
  linksEl.innerHTML = "";

  const nodes = graph.nodes || [];
  const pos = new Map();
  for (const n of nodes) {
    const [x, y] = Array.isArray(n.pos) ? n.pos : [0, 0];
    pos.set(n.id, { x, y, w: (n.size && n.size[0]) || 186, h: (n.size && n.size[1]) || 60 });
  }

  // links first (behind nodes)
  const linksById = new Map();
  for (const l of graph.links || []) {
    const arr = Array.isArray(l) ? l : [l.id, l.origin_id, l.origin_slot, l.target_id, l.target_slot, l.type];
    linksById.set(arr[0], arr);
  }

  for (const n of nodes) {
    const p = pos.get(n.id);
    const el = document.createElement("div");
    el.className = "node st-idle";
    el.style.left = p.x + "px";
    el.style.top = p.y + "px";
    el.dataset.node = n.id;
    const title = NODE_TITLES[n.type] || n.type;
    const body = (n.widgets_values || []).slice(0, 3).map((v) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return `<span>${esc(String(s).slice(0, 44))}</span>`;
    }).join("");
    el.innerHTML = `<div class="n-title">${esc(title)}<span class="n-id">${esc(String(n.id))}</span></div>
      <div class="n-body">${body || `<span>${esc(n.type)}</span>`}</div>
      <div class="n-prog"><i></i></div>`;
    el.title = `${n.type} (#${n.id})\n${(n.widgets_values || []).join(", ")}`;
    nodesEl.appendChild(el);
    state.nodeEls.set(String(n.id), el);
  }

  // draw link paths after nodes exist (so coordinates are known)
  const svgNS = "http://www.w3.org/2000/svg";
  for (const [, arr] of linksById) {
    const [, fromId, fromSlot, toId, toSlot] = arr;
    const a = pos.get(fromId), b = pos.get(toId);
    if (!a || !b) continue;
    const outCount = (nodes.find((n) => n.id === fromId) || {}).outputs || [];
    const inCount = (nodes.find((n) => n.id === toId) || {}).inputs || [];
    const ax = a.x + a.w, ay = a.y + 24 + (fromSlot || 0) * 15;
    const bx = b.x, by = b.y + 24 + (toSlot || 0) * 15;
    const path = document.createElementNS(svgNS, "path");
    const dx = Math.max(50, Math.abs(bx - ax) * 0.5);
    path.setAttribute("d", `M ${ax} ${ay} C ${ax + dx} ${ay}, ${bx - dx} ${by}, ${bx} ${by}`);
    path.setAttribute("class", "link");
    path.dataset.from = String(fromId);
    path.dataset.to = String(toId);
    linksEl.appendChild(path);
  }

  $("#flow-empty").classList.add("hidden");
  if (state.runNodes && Object.keys(state.runNodes).length) applyNodeStates();
}

function nodeTitle(id) {
  const el = state.nodeEls.get(String(id));
  if (!el) return "Node " + id;
  return el.querySelector(".n-title").textContent.replace(/\s*#?\d+$/, "").trim();
}
function explainFor(id, title) {
  const node = state.graph && (state.graph.nodes || []).find((n) => String(n.id) === String(id));
  const t = node ? node.type : "";
  for (const k of Object.keys(EXPLAIN)) if (t.toLowerCase().includes(k.toLowerCase())) return EXPLAIN[k];
  if (node && /sampler/i.test(t)) return "Drawing the image one step at a time — this is the slow part.";
  if (node && /save/i.test(t)) return "Writing the finished file to disk.";
  if (node && /load/i.test(t)) return "Loading an input into the workflow.";
  return `${title} is running.`;
}

function applyNodeStates() {
  for (const [id, info] of Object.entries(state.runNodes || {})) {
    const el = state.nodeEls.get(String(id));
    if (!el) continue;
    const st = info.state || "running";
    el.className = "node st-" + (st === "finished" ? "done" : st === "running" ? "running" : st);
    const bar = el.querySelector(".n-prog i");
    if (bar && info.max) bar.style.width = Math.round(((info.value || 0) / info.max) * 100) + "%";
    if (st === "running") {
      const title = nodeTitle(id);
      if ($("#prog-num").textContent === "" || $("#prog-label").textContent.includes("Loading")) {
        $("#prog-label").textContent = title;
        $("#explain-text").textContent = explainFor(id, title);
      }
    }
  }
  // mark nodes not yet touched as idle only once run started
}

function highlightLinks(nodeId, cls) {
  for (const p of $("#flow-links").querySelectorAll("path")) {
    if (p.dataset.to === String(nodeId)) p.classList.add(cls);
    if (cls === "active" && p.dataset.from === String(nodeId)) p.classList.add("done");
  }
}

function fitGraph() {
  if (!state.graph) return;
  const stage = $("#flow-stage");
  const nodes = state.graph.nodes || [];
  if (!nodes.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const [x, y] = n.pos || [0, 0];
    const w = (n.size && n.size[0]) || 186, h = (n.size && n.size[1]) || 60;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
  }
  const pad = 46;
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const scale = Math.min((sw - pad) / (maxX - minX), (sh - pad) / (maxY - minY), 1.15);
  const tx = (sw - (maxX - minX) * scale) / 2 - minX * scale;
  const ty = (sh - (maxY - minY) * scale) / 2 - minY * scale;
  const canvas = $("#flow-canvas");
  canvas.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`;
}

function startPreviewPoll() {
  if (state.previewPoll) return;
  state.previewPoll = setInterval(async () => {
    try {
      const r = await (await fetch("/api/comfy/queue")).json();
      if (!r.running.length && !r.pending.length) stopPreviewPoll();
    } catch {}
  }, 2500);
}
function stopPreviewPoll() {
  if (state.previewPoll) { clearInterval(state.previewPoll); state.previewPoll = null; }
}

/* ================= run / cancel ================= */
async function runWorkflow(overrides = {}) {
  const file = $("#workflow-pick").value;
  if (!file) { toast("No workflow selected", "err"); return; }
  const body = { file, ...overrides };
  $("#flow-progress").classList.remove("hidden");
  $("#prog-fill").style.width = "4%";
  $("#prog-fill").style.background = "";
  $("#prog-label").textContent = "Queueing…";
  try {
    const r = await fetch("/api/comfy/run", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const out = await r.json();
    if (!r.ok) {
      $("#prog-label").textContent = "Rejected: " + (out.error || "unknown");
      toast(out.error || "Could not run workflow", "err");
      step("Run rejected: " + (out.error || ""), "err");
      return;
    }
    step(`Queued ${file}`, "run");
    await loadGraph(file);
    fitGraph();
  } catch (e) {
    toast("Backend error: " + e.message, "err");
  }
}
async function cancelRun() {
  try { await fetch("/api/comfy/cancel", { method: "POST" }); toast("Stop requested"); step("Stop requested", "err"); }
  catch (e) { toast(e.message, "err"); }
}

/* ================= assets ================= */
async function uploadFile(file) {
  const name = `${Date.now()}_${file.name.replace(/[^\w.\-]/g, "_")}`;
  const item = { name, file, status: "uploading", localUrl: URL.createObjectURL(file) };
  state.attached.push(item);
  renderAttached();

  try {
    const buf = await file.arrayBuffer();
    const r = await fetch("/api/upload?name=" + encodeURIComponent(name), { method: "POST", body: buf });
    if (!r.ok) throw new Error(await r.text());
    item.status = "ready";
    item.serverName = name;
    step(`Uploaded your file: ${file.name}`, "ok");
    // Keep the project's folder the single home for its source material.
    if (state.activeProject) {
      try {
        const a = await fetch("/api/projects/asset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: state.activeProject, name }),
        });
        if (a.ok) step(`Filed it in project "${state.activeProject}"`, "ok");
      } catch {}
    }
  } catch (e) {
    item.status = "error";
    item.error = e.message;
    toast("Upload failed: " + e.message, "err");
  }
  renderAttached();
}
function renderAttached() {
  const strip = $("#attach-strip");
  if (!state.attached.length) { strip.classList.add("hidden"); strip.innerHTML = ""; return; }
  strip.classList.remove("hidden");
  strip.innerHTML = state.attached.map((a, i) => `
    <div class="att">
      ${a.file.type.startsWith("image") ? `<img src="${a.localUrl}" alt="">` : a.file.type.startsWith("audio") ? `<span>&#127925;</span>` : `<span>&#127916;</span>`}
      <span>${esc(a.file.name.slice(0, 22))}</span>
      <span class="${a.status === "ready" ? "ok" : ""}">${a.status === "ready" ? "✓" : a.status === "error" ? "✗" : "…"}</span>
      <span class="x" data-i="${i}">&times;</span>
    </div>`).join("");
  strip.querySelectorAll(".x").forEach((x) => x.onclick = () => {
    state.attached.splice(Number(x.dataset.i), 1);
    renderAttached();
  });
}

/* ================= projects ================= */
async function loadProjects() {
  try {
    const r = await (await fetch("/api/projects")).json();
    state.projects = r.projects || [];
    state.activeProject = r.active || "";
    renderProjects();
    renderProjectChip();
  } catch {}
}

function renderProjectChip() {
  const c = $("#proj-chip");
  if (!c) return;
  if (state.activeProject) {
    c.textContent = state.activeProject;
    c.classList.add("set");
    c.title = 'Working in project "' + state.activeProject + '". Click to switch.';
  } else {
    c.textContent = "No project";
    c.classList.remove("set");
    c.title = "No project folder yet. Click to create one.";
  }
}

function renderProjects() {
  const list = $("#projects-list");
  const empty = $("#projects-empty");
  if (!list) return;
  if (!state.projects.length) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  list.innerHTML = state.projects.map((p) => {
    const active = p.slug === state.activeProject;
    return `<div class="proj-card${active ? " active" : ""}" data-slug="${esc(p.slug)}" title="Click to work in this project">
      <h4>${esc(p.name)}</h4>
      ${p.description ? `<p>${esc(p.description)}</p>` : ""}
      <div class="proj-meta">
        <span><b>${p.assets}</b> ${p.assets === 1 ? "asset" : "assets"}</span>
        <span><b>${p.results}</b> ${p.results === 1 ? "result" : "results"}</span>
        ${p.created ? `<span>${esc(p.created)}</span>` : ""}
        ${p.github ? `<span class="proj-gh" title="${esc(p.github)}">on GitHub</span>` : ""}
      </div>
      <div class="proj-actions">
        <button class="ghost use">${active ? "In use" : "Use this project"}</button>
        <button class="ghost pub" title="Save a snapshot of this project">Publish</button>
      </div>
    </div>`;
  }).join("");
  list.querySelectorAll(".proj-card").forEach((el) => {
    el.addEventListener("click", () => selectProject(el.dataset.slug === state.activeProject ? "" : el.dataset.slug));
  });
  list.querySelectorAll(".proj-card .pub").forEach((el) => {
    el.addEventListener("click", (ev) => { ev.stopPropagation(); publishProject(el.closest(".proj-card").dataset.slug); });
  });
}

async function selectProject(slug) {
  try {
    const r = await (await fetch("/api/projects/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    })).json();
    state.activeProject = (r && r.active) || slug;
    renderProjects();
    renderProjectChip();
    toast(state.activeProject ? 'Working in project "' + state.activeProject + '"' : "No project selected", "ok");
  } catch {
    toast("Could not switch project", "err");
  }
}

async function newProject() {
  const name = window.prompt('Name for the new project (for example: "Album cover")');
  if (!name || !name.trim()) return;
  const description = window.prompt("One line about what this project is (optional)") || "";
  try {
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), description }),
    });
    const j = await res.json();
    if (!res.ok) { toast(j.error || "Could not create the project", "err"); return; }
    state.activeProject = j.slug;
    await loadProjects();
    toast('Project "' + j.name + '" created', "ok");
  } catch {
    toast("Could not create the project", "err");
  }
}

async function publishProject(slug) {
  // Always safe: a snapshot stays on this laptop. GitHub is asked separately.
  let create = false;
  const onGitHub = window.confirm(
    `Publish "${slug}"?\n\n` +
      "This saves a snapshot on this laptop.\n\n" +
      "Press OK to also upload it to your GitHub account as a private repository.\n" +
      "Press Cancel to keep it on this laptop only."
  );
  if (onGitHub) create = true;
  try {
    const res = await fetch("/api/projects/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, create, visibility: "private" }),
    });
    const r = await res.json();
    if (!res.ok) { toast(r.error || "Could not publish", "err"); return; }
    await loadProjects();
    if (r.created) toast("Published to GitHub: " + (r.remote || slug), "ok");
    else if (r.createdError) toast("Saved on this laptop. GitHub said: " + r.createdError, "err");
    else if (r.committed) toast('Snapshot of "' + slug + '" saved on this laptop', "ok");
    else toast("Nothing to publish — it is already up to date", "ok");
  } catch {
    toast("Could not publish", "err");
  }
}

async function loadAssets() {
  try {
    const r = await (await fetch("/api/assets")).json();
    state.assets = r.assets || [];
    renderAssets();
  } catch {}
}
function renderAssets() {
  const g = $("#assets-grid");
  if (!state.assets.length) { g.innerHTML = ""; return; }
  g.innerHTML = state.assets.map((a) => {
    const url = `/api/file?path=${encodeURIComponent(`D:\\ComfyUI_windows_portable\\ComfyUI\\input\\${a.name}`)}`;
    const isAud = /\.(mp3|wav|flac|ogg|m4a|opus)$/i.test(a.name);
    const inner = isAud
      ? `<audio class="res-audio" src="${url}" controls preload="metadata" onclick="event.stopPropagation()"></audio>`
      : `<img src="${url}" loading="lazy" onerror="this.style.display='none'">`;
    return `<div class="res${isAud ? " res-audio-card" : ""}" data-url="${url}">${inner}
      <div class="res-cap">${esc(a.name)}</div></div>`;
  }).join("");
  bindLightbox(g);
}

/* ================= results ================= */
async function loadResults() {
  try {
    const r = await (await fetch("/api/results?limit=30")).json();
    const fresh = (r.results || []).filter((x) => /\.(png|jpg|jpeg|webp|gif|mp4|webm|mov|mp3|wav|flac|ogg|m4a|opus)$/i.test(x.name));
    const prev = new Set(state.results.map((x) => x.url));
    state.results = fresh;
    renderResults();
    for (const f of fresh) if (!prev.has(f.url)) { /* new since last poll */ }
  } catch {}
}
function addResult(item) {
  state.results.unshift(item);
  renderResults();
}
function renderResults() {
  const g = $("#results-grid");
  const empty = $("#results-empty");
  if (!state.results.length) { g.innerHTML = ""; empty.classList.remove("hidden"); return; }
  empty.classList.add("hidden");
  g.innerHTML = state.results.map((r) => {
    const isAud = /\.(mp3|wav|flac|ogg|m4a|opus)$/i.test(r.name);
    const isVid = !isAud && (r.video || /\.(mp4|webm|gif|mov)$/i.test(r.name));
    const inner = isAud
      ? `<audio class="res-audio" src="${r.url}" controls preload="metadata" onclick="event.stopPropagation()"></audio>`
      : isVid
        ? `<video src="${r.url}" muted loop autoplay playsinline></video>`
        : `<img src="${r.url}" loading="lazy">`;
    const when = r.mtime ? new Date(r.mtime).toLocaleTimeString() : "";
    return `<div class="res${isAud ? " res-audio-card" : ""}" data-url="${r.url}" title="${esc(r.name)}">${inner}
      <span class="badge">${isAud ? "audio" : isVid ? "video" : "image"}</span>
      <div class="res-cap">${esc(r.name)}${when ? " · " + when : ""}</div></div>`;
  }).join("");
  bindLightbox(g);
}
function bindLightbox(grid) {
  grid.querySelectorAll(".res").forEach((el) => {
    el.onclick = () => {
      const url = el.dataset.url;
      if (!url) return;
      const lb = $("#lightbox");
      const target = $("#lightbox-img");
      const drop = (sel) => { const el = lb.querySelector(sel); if (el) el.remove(); };
      if (/\.(mp3|wav|flac|ogg|m4a|opus)$/i.test(url)) {
        target.style.display = "none";
        drop("video");
        let a = lb.querySelector("audio");
        if (!a) { a = document.createElement("audio"); a.controls = true; a.autoplay = true; a.style.maxWidth = "86vw"; lb.insertBefore(a, $("#lightbox-close")); }
        a.src = url; a.classList.remove("hidden");
      } else if (/\.(mp4|webm|mov)$/i.test(url)) {
        target.style.display = "none";
        drop("audio");
        let v = lb.querySelector("video");
        if (!v) { v = document.createElement("video"); v.controls = true; v.autoplay = true; v.style.maxWidth = "92vw"; v.style.maxHeight = "88vh"; v.style.borderRadius = "12px"; lb.insertBefore(v, $("#lightbox-close")); }
        v.src = url; v.classList.remove("hidden");
      } else {
        drop("video"); drop("audio");
        target.style.display = ""; target.src = url;
      }
      lb.classList.remove("hidden");
    };
  });
}

/* ================= send ================= */
async function send(text) {
  text = (text ?? $("#msg").value).trim();
  if (!text && !state.attached.length) return;
  if (state.busy) { toast("Still working — press Stop first", "err"); return; }

  const readyFiles = state.attached.filter((a) => a.status === "ready");
  if (state.attached.some((a) => a.status === "uploading")) { toast("Wait for the upload to finish"); return; }

  addMsg("user", text || "(sent an image)");
  $("#msg").value = "";
  autoGrow();
  state.attached = [];
  renderAttached();

  // make sure the AI knows what tools it has for this request
  const intro = readyFiles.length
    ? `${text}\n\n(I attached ${readyFiles.length} file(s): ${readyFiles.map((f) => f.serverName).join(", ")}. They are in ComfyUI's input folder as well.)`
    : text;

  state.busy = true;
  liveShow("Thinking…");

  const model = $("#model-pick").value;
  let body = { text: intro, files: readyFiles.map((f) => ({ name: f.serverName })) };
  if (model && model.includes("|")) {
    const [providerID, modelID] = model.split("|");
    await fetch("/api/session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: { providerID, modelID } }),
    }).catch(() => {});
  }

  try {
    const r = await fetch("/api/prompt", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = await r.json();
    if (!r.ok) {
      state.busy = false; liveHide();
      addMsg("ai", "Something went wrong sending that.", out.error);
      toast(out.error || "Send failed", "err");
    }
  } catch (e) {
    state.busy = false; liveHide();
    toast("Backend error: " + e.message, "err");
  }
}
async function stopAI() {
  try { await fetch("/api/abort", { method: "POST" }); state.busy = false; liveHide(); toast("Stopped"); step("Stopped by you", "err"); }
  catch (e) { toast(e.message, "err"); }
}
function autoGrow() {
  const t = $("#msg");
  t.style.height = "auto";
  t.style.height = Math.min(130, t.scrollHeight) + "px";
}

/* ================= wiring ================= */
function bindUI() {
  $("#composer").addEventListener("submit", (e) => { e.preventDefault(); send(); });
  $("#msg").addEventListener("input", autoGrow);
  $("#msg").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $("#btn-stop").addEventListener("click", stopAI);
  $("#perm-once").addEventListener("click", () => replyPermission("once"));
  $("#perm-always").addEventListener("click", () => replyPermission("always"));
  $("#perm-reject").addEventListener("click", () => replyPermission("reject"));
  $("#btn-run").addEventListener("click", () => runWorkflow({}));
  $("#btn-cancel").addEventListener("click", cancelRun);
  $("#btn-fit").addEventListener("click", fitGraph);
  $("#btn-new-chat").addEventListener("click", async () => {
    if (!confirm("Start a new conversation? The old one stays saved in opencode.")) return;
    $("#messages").innerHTML = "";
    $("#welcome").classList.remove("hidden");
    await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reset: true }) });
    toast("New chat started", "ok");
  });

  // examples
  $$(".chip").forEach((c) => c.addEventListener("click", () => { $("#msg").value = c.dataset.ex; autoGrow(); $("#msg").focus(); }));

  // ---- Apps dropdown: built-in pages + anything the AI has built ----
  (function appsMenu() {
    const btn = $("#apps-btn"), pop = $("#apps-pop");
    if (!btn || !pop) return;
    const builtinBox = $("#apps-builtin"), listBox = $("#apps-list");

    function item(entry) {
      const isWeb = !!(entry.web && entry.web.page);
      const a = document.createElement(isWeb ? "a" : "button");
      a.className = "apps-item";
      if (isWeb) { a.href = entry.web.page; a.target = "_blank"; }
      const kind = document.createElement("span");
      kind.className = "kind";
      kind.textContent = entry.kind || "app";
      const nm = document.createElement("span");
      nm.className = "nm"; nm.textContent = entry.name || entry.id;
      const ds = document.createElement("span");
      ds.className = "ds"; ds.textContent = entry.description || "";
      a.append(kind, nm, ds);
      if (!isWeb) {
        a.title = "Chat-only app — click to ask the AI to run it";
        a.addEventListener("click", (e) => {
          e.preventDefault();
          pop.classList.add("hidden");
          $("#msg").value = `Run the ${entry.name} app for me — `;
          autoGrow(); $("#msg").focus();
        });
      }
      return a;
    }

    async function refresh() {
      try {
        const r = await (await fetch("/api/apps")).json();
        builtinBox.innerHTML = "";
        listBox.innerHTML = "";
        for (const b of r.builtins || []) builtinBox.appendChild(item(b));
        const list = r.apps || [];
        if (!list.length) listBox.innerHTML = '<span class="apps-empty">Nothing built yet — ask the chat for a new tool.</span>';
        for (const app of list) listBox.appendChild(item(app));
      } catch (e) { /* menu stays empty; not fatal */ }
    }

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = pop.classList.toggle("hidden");
      if (!open) refresh();
    });
    document.addEventListener("click", (e) => { if (!pop.contains(e.target) && e.target !== btn) pop.classList.add("hidden"); });
    const ask = $("#apps-ask");
    if (ask) ask.addEventListener("click", () => {
      pop.classList.add("hidden");
      $("#msg").value = "Build me an app that ";
      autoGrow(); $("#msg").focus();
    });
    window.__refreshApps = refresh;
  })();

  // tabs
  function showTab(name) {
    $$(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
    $$(".tab-body").forEach((b) => b.classList.toggle("hidden", b.id !== "tab-" + name));
    if (name === "results") loadResults();
    if (name === "assets") loadAssets();
    if (name === "projects") loadProjects();
  }
  window.__showTab = showTab;
  $$(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));

  // project chip in the chat header
  const chip = $("#proj-chip");
  if (chip) chip.addEventListener("click", () => showTab("projects"));
  const newProj = $("#btn-new-project");
  if (newProj) newProj.addEventListener("click", (e) => { e.stopPropagation(); newProject(); });

  // file input
  $("#file-input").addEventListener("change", (e) => { for (const f of e.target.files) uploadFile(f); e.target.value = ""; });
  $("#dropzone").addEventListener("dragover", (e) => { e.preventDefault(); $("#dropzone").classList.add("over"); });
  $("#dropzone").addEventListener("dragleave", () => $("#dropzone").classList.remove("over"));
  $("#dropzone").addEventListener("drop", (e) => { e.preventDefault(); $("#dropzone").classList.remove("over"); for (const f of e.dataTransfer.files) uploadFile(f); });

  // drag anywhere
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => { if ([...e.dataTransfer.types].includes("Files")) { dragDepth++; document.body.classList.add("dragging"); } });
  window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove("dragging"); });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault(); dragDepth = 0; document.body.classList.remove("dragging");
    if (e.dataTransfer.files.length) for (const f of e.dataTransfer.files) uploadFile(f);
  });

  // lightbox close
  $("#lightbox").addEventListener("click", (e) => {
    if (e.target.id === "lightbox" || e.target.id === "lightbox-close") {
      $("#lightbox").classList.add("hidden");
      const v = $("#lightbox").querySelector("video"); if (v) { v.pause(); v.removeAttribute("src"); }
      const a = $("#lightbox").querySelector("audio"); if (a) { a.pause(); a.removeAttribute("src"); }
      $("#lightbox-img").src = "";
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { $("#lightbox").classList.add("hidden"); }
  });

  window.addEventListener("resize", () => { clearTimeout(window._ft); window._ft = setTimeout(fitGraph, 150); });

  $("#model-pick").addEventListener("change", async () => {
    const v = $("#model-pick").value; if (!v.includes("|")) return;
    const [providerID, modelID] = v.split("|");
    try {
      await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: { providerID, modelID } }) });
      toast("Switched to " + modelID, "ok");
      step("Model set to " + modelID, "ok");
    } catch (e) { toast("Could not switch model", "err"); }
  });
}

async function loadPermissions() {
  if (state.pendingPerm) return;
  try {
    const r = await fetch("/api/permissions");
    if (!r.ok) return;
    const list = await r.json();
    const pending = Array.isArray(list) ? list : (list && list.data) || [];
    if (pending.length) showPermission(pending[0]);
  } catch {}
}

/* ================= boot ================= */
(async function boot() {
  bindUI();
  connectEvents();
  loadStatus();
  loadWorkflows();
  loadResults();
  loadAssets();
  loadPermissions();
  loadProjects();
  setInterval(loadResults, 6000);
  setInterval(loadPermissions, 3000);
  setInterval(() => { if (!state.busy) loadStatus(); }, 20000);
})();
