"use strict";

// ============================================================
// AI Studio - local backend
//
// One Node process that glues three local services together and
// serves the browser GUI:
//   * opencode  (the AI you are talking to)   -> SSE into the chat panel
//   * ComfyUI   (the image/video generator)   -> SSE into the workflow panel
//   * Ollama    (local models)                -> status only
//
// Everything stays on 127.0.0.1. No accounts, no cloud, no install step.
// ============================================================

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { convertWorkflow, buildObjectInfoIndex, findImageInputs, findPromptNodes, pickPositivePromptNode, pickNegativePromptNode } = require("./convert.js");
const projects = require("./projects.js");
const apps = require("./apps.js");
const capabilities = require("./capabilities.js");
const browser = require("./browser.js");
const connectors = require("./connectors.js");

const PORT = Number(process.env.STUDIO_PORT || 7860);
// opencode serve must be launched with ROOT as its working directory, otherwise
// it ignores the project's opencode.json (MCP tools + default model).
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT || 4097);
const OPENCODE_EXE = process.env.OPENCODE_EXE || "opencode";
const COMFY_URL = process.env.COMFY_URL || "http://127.0.0.1:8188";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";

const ROOT = path.resolve(__dirname, "..");                 // workflow shortcuts folder
const STUDIO = __dirname;
const DATA = path.join(STUDIO, "data");
const PUBLIC = path.join(STUDIO, "public");
const COMFY_ROOT = "D:\\ComfyUI_windows_portable";
const COMFY_INPUT = path.join(COMFY_ROOT, "ComfyUI", "input");
const COMFY_OUTPUT = path.join(COMFY_ROOT, "ComfyUI", "output");

// ComfyUI only streams execution events back to the client_id that submitted
// the job, so the WebSocket and every /prompt call must share one id.
const COMFY_CLIENT_ID = "ai-studio";

const OC_USER = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const OC_PASS = process.env.OPENCODE_SERVER_PASSWORD || "";

for (const d of [DATA, path.join(DATA, "uploads")]) fs.mkdirSync(d, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- tiny helpers ----------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}
function fail(res, code, message, extra = {}) { json(res, code, { error: message, ...extra }); }

const MIME_BY_EXT = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".wav": "audio/wav", ".mp3": "audio/mpeg",
};
function mimeFor(name) {
  return MIME_BY_EXT[path.extname(String(name)).toLowerCase()] || "application/octet-stream";
}

// opencode re-reads every stored attachment URI on every turn. A session that ever
// stored a non-inline URI (the old file:// form) can never complete a turn again,
// so we detect that and start a fresh session instead of failing forever.
async function sessionIsPoisoned(sid) {
  try {
    const m = await oc(`/api/session/${sid}/message`);
    const msgs = Array.isArray(m) ? m : m.data || [];
    for (const msg of msgs) {
      for (const f of msg.files || []) {
        if (f && f.uri && !/^data:/.test(String(f.uri))) return true;
      }
    }
  } catch {}
  return false;
}

function ocHeaders(extra = {}) {
  return {
    Authorization: "Basic " + Buffer.from(`${OC_USER}:${OC_PASS}`).toString("base64"),
    ...extra,
  };
}

async function oc(pathname, opts = {}) {
  const res = await fetch(`http://127.0.0.1:${OPENCODE_PORT}${pathname}`, {
    ...opts,
    headers: ocHeaders({ "Content-Type": "application/json", ...(opts.headers || {}) }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const msg = typeof body === "string" ? body : JSON.stringify(body);
    const err = new Error(`opencode ${pathname} -> ${res.status}: ${msg.slice(0, 600)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function probe(url, timeout = 2500) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

// ---------- keep opencode alive ----------
let ocProc = null;

async function ensureOpencode() {
  try { const h = await oc("/api/health"); if (h) { broadcast("service", { name: "opencode", state: "connected" }); return; } } catch {}

  if (ocProc) return;   // already launching

  log("starting opencode serve on port", OPENCODE_PORT, "(cwd:", ROOT + ")");
  const args = ["serve", "--port", String(OPENCODE_PORT), "--hostname", "127.0.0.1"];
  const spawnOpts = { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false };

  // "opencode" is a .ps1/.cmd shim on Windows; resolve a runnable entry point.
  let cmd = OPENCODE_EXE;
  if (OPENCODE_EXE === "opencode") {
    const jsShim = path.join(process.env.APPDATA || "", "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");
    if (jsShim && fs.existsSync(jsShim)) cmd = jsShim;
  }

  ocProc = spawn(cmd, args, spawnOpts);
  ocProc.stdout && ocProc.stdout.on("data", (d) => log("oc:", String(d).trim().slice(0, 300)));
  ocProc.stderr && ocProc.stderr.on("data", (d) => log("oc!", String(d).trim().slice(0, 300)));
  ocProc.on("exit", (code) => {
    log("opencode exited with", code);
    ocProc = null;
    broadcast("service", { name: "opencode", state: "disconnected" });
    setTimeout(ensureOpencode, 4000);
  });
  ocProc.on("error", (e) => { log("opencode spawn error:", e.message); ocProc = null; setTimeout(ensureOpencode, 6000); });

  // wait for it to accept connections
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { await oc("/api/health"); log("opencode ready"); broadcast("service", { name: "opencode", state: "connected" }); connectOpencodeStream(); return; } catch {}
  }
  log("opencode did not become ready in 40s");
}

// ---------- session state ----------
const state = {
  sessionId: null,
  model: { providerID: "opencode", modelID: "mimo-v2.6-flash-free" },
  lastPromptAt: 0,
  activeProject: "",
};

function loadState() {
  try { Object.assign(state, JSON.parse(fs.readFileSync(path.join(DATA, "state.json"), "utf8"))); } catch {}
}
function saveState() {
  try { fs.writeFileSync(path.join(DATA, "state.json"), JSON.stringify(state, null, 2)); } catch {}
}
loadState();

// ---------- browser event bus ----------
const clients = new Set();
function broadcast(type, data) {
  const line = `event: ${type}\ndata: ${JSON.stringify({ type, data, t: Date.now() })}\n\n`;
  for (const res of clients) {
    try { res.write(line); } catch { clients.delete(res); }
  }
}

// ============================================================
// opencode bridge: one SSE subscription reused for every browser
// ============================================================
let ocStreamAbort = null;
let ocStreamRunning = false;
const ocBuffer = new Map();   // messageID -> assistant text collected live

async function connectOpencodeStream() {
  if (ocStreamRunning) return;
  ocStreamRunning = true;
  ocStreamAbort = new AbortController();

  const pump = async () => {
    while (!ocStreamAbort.signal.aborted) {
      try {
        const res = await fetch(`http://127.0.0.1:${OPENCODE_PORT}/event`, {
          headers: ocHeaders({ Accept: "text/event-stream" }),
          signal: ocStreamAbort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`status ${res.status}`);
        broadcast("service", { name: "opencode", state: "connected" });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const ln of lines) {
            if (!ln.startsWith("data: ")) continue;
            try { handleOpencodeEvent(JSON.parse(ln.slice(6))); } catch {}
          }
        }
        throw new Error("stream closed");
      } catch (e) {
        if (ocStreamAbort.signal.aborted) break;
        broadcast("service", { name: "opencode", state: "reconnecting", detail: String(e.message || e) });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    ocStreamRunning = false;
  };
  pump();
}

// The agent's only sanctioned shell command is our own studio CLI. opencode's
// bash permission globs are inconsistent on Windows, so rather than leaving the
// user clicking "allow" five times per image, we approve exactly that command
// here and hand everything else to the human in the browser.
const SAFE_STUDIO_CALL = /^\s*node\s+studio[\\/]studio\.js(?:\s|$)/i;
const autoApproved = new Set();

function autoApproveSafeStudioCall(d) {
  if (!d || !d.id || d.action !== "bash") return false;
  const resources = d.resources || [];
  if (!resources.length) return false;
  if (!resources.every((r) => SAFE_STUDIO_CALL.test(String(r)))) return false;
  if (autoApproved.has(d.id)) return true;
  autoApproved.add(d.id);
  if (autoApproved.size > 500) autoApproved.clear();

  const sid = d.sessionID || state.sessionId;
  if (!sid) return false;
  oc(`/api/session/${sid}/permission/${d.id}/reply`, { method: "POST", body: JSON.stringify({ reply: "once" }) })
    .then(() => log("auto-approved studio CLI call:", resources[0]))
    .catch((e) => log("auto-approve failed:", e.message));
  return true;
}

function handleOpencodeEvent(evt) {
  const t = evt.type || "";
  // The global /event stream nests payload under `properties`, while the
  // per-session stream nests it under `data`. Normalise to one shape.
  const d = evt.data || evt.properties || {};

  // Every opencode event also goes to the browser so the GUI can render
  // the agent's live reasoning/tool use verbatim.
  broadcast("opencode", { type: t, data: d });

  if (t === "server.connected") broadcast("service", { name: "opencode", state: "connected" });

  // The agent wants to run a command / touch a file -> ask the human.
  if (t === "permission.v2.asked" || t === "permission.asked") {
    if (autoApproveSafeStudioCall(d)) {
      broadcast("permission_auto", { id: d.id, resources: d.resources || [] });
      return;
    }
    broadcast("permission_asked", d);
  }
  if (t === "permission.v2.replied" || t === "permission.replied") {
    broadcast("permission_resolved", d);
  }

  if (t === "session.next.text.delta") {
    const k = d.assistantMessageID || "x";
    const cur = ocBuffer.get(k) || { text: "", reasoning: "" };
    cur.text += d.delta != null ? d.delta : (d.text || "");
    ocBuffer.set(k, cur);
  }
  if (t === "session.next.reasoning.delta") {
    const k = d.assistantMessageID || "x";
    const cur = ocBuffer.get(k) || { text: "", reasoning: "" };
    cur.reasoning += d.delta != null ? d.delta : (d.text || d.reasoning || "");
    ocBuffer.set(k, cur);
  }
  if (t === "session.next.text.ended") {
    const k = d.assistantMessageID;
    if (k) {
      const cur = ocBuffer.get(k) || { text: "", reasoning: "" };
      if (d.text) cur.text = d.text;
      broadcast("assistant_text", { messageID: k, text: cur.text, reasoning: cur.reasoning });
      ocBuffer.delete(k);
    }
  }
  if (t === "session.next.step.ended" && d.finish === "stop") {
    broadcast("agent_idle", {});
  }
}

// ============================================================
// ComfyUI bridge: WebSocket -> browser SSE
// ============================================================
let comfyWs = null;
let comfyRetry = null;
let currentRun = null;   // { promptId, workflow, startedAt, nodes:{id:{state,value,max}} }

function connectComfy() {
  try { comfyWs = new WebSocket(`${COMFY_URL.replace("http", "ws")}/ws?clientId=${COMFY_CLIENT_ID}`); }
  catch { scheduleComfyRetry(); return; }

  comfyWs.addEventListener("open", () => {
    broadcast("service", { name: "comfyui", state: "connected" });
    log("ComfyUI websocket connected");
  });

  comfyWs.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") { broadcast("comfy_preview", { base64: bufferToBase64(ev.data) }); return; }
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    handleComfyEvent(msg);
  });

  comfyWs.addEventListener("close", () => { broadcast("service", { name: "comfyui", state: "disconnected" }); scheduleComfyRetry(); });
  comfyWs.addEventListener("error", () => { try { comfyWs.close(); } catch {} });
}

function bufferToBase64(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return buf.toString("base64");
}

function scheduleComfyRetry() {
  clearTimeout(comfyRetry);
  comfyRetry = setTimeout(connectComfy, 4000);
}

function handleComfyEvent(msg) {
  const d = msg.data || {};

  if (msg.type === "status") {
    broadcast("comfy_queue", d.status && d.status.exec_info ? d.status.exec_info : {});
    return;
  }
  if (msg.type === "execution_start") {
    currentRun = { promptId: d.prompt_id, startedAt: Date.now(), nodes: {}, graph: currentRun ? currentRun.graph : null, workflow: currentRun ? currentRun.workflow : null };
    broadcast("comfy_run_start", { promptId: d.prompt_id });
    return;
  }
  if (msg.type === "execution_cached") {
    for (const id of d.nodes || []) setNode(id, "cached", 1, 1);
    broadcast("comfy_nodes", currentRun ? currentRun.nodes : {});
    return;
  }
  if (msg.type === "executing") {
    if (d.node == null) {
      if (currentRun) broadcast("comfy_run_end", { promptId: currentRun.promptId, ok: true, elapsed: Date.now() - currentRun.startedAt });
      currentRun = null;
      return;
    }
    setNode(d.node, "running", 0, 1);
    broadcast("comfy_nodes", currentRun.nodes);
    return;
  }
  if (msg.type === "progress_state" && d.nodes) {
    for (const [id, n] of Object.entries(d.nodes)) setNode(id, n.state, n.value, n.max);
    broadcast("comfy_nodes", currentRun ? currentRun.nodes : {});
    return;
  }
  if (msg.type === "progress") {
    setNode(String(d.node), "running", d.value, d.max);
    broadcast("comfy_progress", { node: String(d.node), value: d.value, max: d.max });
    return;
  }
  if (msg.type === "executed") {
    setNode(String(d.node), "done", 1, 1);
    const outputs = d.output ? (d.output.images || d.output.videos || d.output.gifs || d.output.animated || []) : [];
    broadcast("comfy_output", { node: d.node, outputs, promptId: d.prompt_id });
    broadcast("comfy_nodes", currentRun ? currentRun.nodes : {});
    return;
  }
  if (msg.type === "execution_success") {
    broadcast("comfy_run_end", { promptId: d.prompt_id, ok: true });
    return;
  }
  if (msg.type === "execution_error") {
    setNode(String(d.node_id), "error", 0, 1);
    broadcast("comfy_error", { nodeId: d.node_id, message: d.exception_message, details: d.traceback });
    broadcast("comfy_run_end", { promptId: d.prompt_id, ok: false, message: d.exception_message });
    return;
  }
  if (msg.type === "validation_error") {
    broadcast("comfy_error", { message: "Workflow validation failed", details: d.node_errors || d.errors });
    return;
  }
  broadcast("comfy_raw", { type: msg.type, data: d });
}

function setNode(id, stateName, value, max) {
  if (!currentRun) currentRun = { promptId: null, startedAt: Date.now(), nodes: {}, graph: null, workflow: null };
  const n = currentRun.nodes[id] || {};
  n.state = stateName;
  if (typeof value === "number") n.value = value;
  if (typeof max === "number") n.max = max;
  currentRun.nodes[id] = n;
}

// ============================================================
// HTTP routing
// ============================================================
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".webm": "video/webm",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

function serveFile(res, absPath) {
  fs.stat(absPath, (err, st) => {
    if (err || !st.isFile()) return fail(res, 404, "Not found");
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(absPath).toLowerCase()] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(absPath).pipe(res);
  });
}

function readBody(req, limit = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("Payload too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  try {
    // ---- live event stream to the browser ----
    if (p === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ type: "hello", t: Date.now() })}\n\n`);
      clients.add(res);
      connectOpencodeStream();
      req.on("close", () => clients.delete(res));
      return;
    }

    // ---- health of everything ----
    if (p === "/api/status") {
      const [comfy, ollama, ocOk, models] = await Promise.all([
        probe(`${COMFY_URL}/system_stats`).then(async (ok) => {
          if (!ok) return { connected: false };
          try {
            const s = await (await fetch(`${COMFY_URL}/system_stats`)).json();
            const q = await (await fetch(`${COMFY_URL}/queue`)).json();
            const dev = (s.devices || [])[0] || {};
            return { connected: true, version: s.system.comfyui_version, gpu: dev.name, vramFreeGB: dev.vram_free ? +(dev.vram_free / 1e9).toFixed(2) : null, running: (q.queue_running || []).length, pending: (q.queue_pending || []).length };
          } catch { return { connected: false }; }
        }),
        probe(`${OLLAMA_URL}/api/tags`).then(async (ok) => {
          if (!ok) return { connected: false };
          try { const t = await (await fetch(`${OLLAMA_URL}/api/tags`)).json(); return { connected: true, models: (t.models || []).map((m) => m.name) }; }
          catch { return { connected: false }; }
        }),
        (async () => {
          try { const h = await oc("/api/health"); return { connected: true, healthy: h.healthy !== false }; }
          catch (e) { return { connected: false, detail: String(e.message).slice(0, 200) }; }
        })(),
        (async () => {
          try { const m = await oc("/api/model"); return (m.data || []).map((x) => ({ id: x.id, providerID: x.providerID, name: x.name, status: x.status, input: (x.capabilities && x.capabilities.input) || [] })); }
          catch { return []; }
        })(),
      ]);
      return json(res, 200, { comfy, ollama, opencode: ocOk, models, session: state.sessionId, model: state.model, activeProject: state.activeProject || "", port: PORT });
    }

    // ---- opencode: create / resume a session ----
    if (p === "/api/session" && req.method === "POST") {
      const body = await readBody(req, 1024 * 1024).then((b) => JSON.parse(b || "{}")).catch(() => ({}));
      if (body.reset || !state.sessionId) {
        const created = await oc("/api/session", { method: "POST", body: JSON.stringify({ directory: ROOT }) });
        state.sessionId = created.data ? created.data.id : created.id;
        saveState();
        log("session created", state.sessionId);
      }
      // Always pin a model that actually responds (the account default is deprecated).
      if (body.model) state.model = body.model;
      try {
        await oc(`/api/session/${state.sessionId}/model`, { method: "POST", body: JSON.stringify({ model: { id: state.model.modelID, providerID: state.model.providerID } }) });
      } catch (e) { log("model pin failed:", e.message); }
      saveState();
      return json(res, 200, { sessionId: state.sessionId, model: state.model });
    }

    if (p === "/api/session" && req.method === "GET") {
      try {
        const list = await oc("/api/session");
        return json(res, 200, { current: state.sessionId, sessions: (Array.isArray(list) ? list : list.data || []).map((s) => ({ id: s.id, title: s.title })) });
      } catch (e) { return fail(res, 502, e.message); }
    }

    // ---- opencode: send a message (with optional attachments) ----
    if (p === "/api/prompt" && req.method === "POST") {
      const raw = await readBody(req, 80 * 1024 * 1024);
      const body = JSON.parse(raw.toString("utf8") || "{}");
      if (!body.text || !body.text.trim()) return fail(res, 400, "Message text is required");

      if (!state.sessionId) {
        const created = await oc("/api/session", { method: "POST", body: JSON.stringify({ directory: ROOT }) });
        state.sessionId = created.data ? created.data.id : created.id;
        try {
          await oc(`/api/session/${state.sessionId}/model`, { method: "POST", body: JSON.stringify({ model: { id: state.model.modelID, providerID: state.model.providerID } }) });
        } catch {}
        saveState();
      }

      if (await sessionIsPoisoned(state.sessionId)) {
        const created = await oc("/api/session", { method: "POST", body: JSON.stringify({ directory: ROOT }) });
        state.sessionId = created.data ? created.data.id : created.id;
        try {
          await oc(`/api/session/${state.sessionId}/model`, { method: "POST", body: JSON.stringify({ model: { id: state.model.modelID, providerID: state.model.providerID } }) });
        } catch {}
        saveState();
        log("session recycled (unreadable attachment in history)", state.sessionId);
        broadcast("session_recycled", { session: state.sessionId });
      }

      // Attachments the GUI uploaded become data: URIs opencode can read.
      // opencode does NOT resolve file:// paths here (it sends empty media), so we
      // inline base64 ourselves. The browser sends objects ({name}), tolerate strings too.
      const files = [];
      const MAX_ATTACH = 6 * 1024 * 1024;
      for (const f of body.files || []) {
        const name = typeof f === "string" ? f : f && (f.name || f.serverName || f.filename);
        if (!name) continue;
        const base = path.basename(String(name));
        const local = path.join(DATA, "uploads", base);
        if (!fs.existsSync(local)) continue;
        const mime = (f && f.mime) || mimeFor(base);
        const st = fs.statSync(local);
        if (st.size > MAX_ATTACH) {
          files.push({ uri: "file:///" + local.replace(/\\/g, "/"), mime, name: base });
          continue;
        }
        files.push({ uri: "data:" + mime + ";base64," + fs.readFileSync(local).toString("base64"), mime, name: base });
      }

      // Tell the AI which project folder it is working in, so results get filed
      // in the right place without the human having to explain it every time.
      let text = body.text;
      const proj = body.project || state.activeProject;
      if (proj && projects.readMeta(proj)) {
        text = `(Working project: "${proj}" — folder projects/${proj}, assets in its assets/ folder, results go in its results/ folder. When you queue a render, add project=${proj} to run and to wait.)\n\n${body.text}`;
      }

      const payload = { prompt: { text, ...(files.length ? { files } : {}) } };
      if (body.reset) { payload.resume = false; }
      state.lastPromptAt = Date.now();
      broadcast("prompt_sent", { text: body.text, files: files.map((f) => f.name) });

      try {
        const out = await oc(`/api/session/${state.sessionId}/prompt`, { method: "POST", body: JSON.stringify(payload) });
        return json(res, 200, { ok: true, session: state.sessionId, reply: out.data || out });
      } catch (e) {
        // Session state may be stale; recreate once and retry.
        if (e.status === 404 || /busy|not found/i.test(e.message)) {
          const created = await oc("/api/session", { method: "POST", body: JSON.stringify({ directory: ROOT }) });
          state.sessionId = created.data ? created.data.id : created.id;
          saveState();
          const out = await oc(`/api/session/${state.sessionId}/prompt`, { method: "POST", body: JSON.stringify(payload) });
          return json(res, 200, { ok: true, session: state.sessionId, reply: out.data || out });
        }
        return fail(res, 502, e.message, { body: e.body });
      }
    }

    // ---- opencode: conversation history for the chat panel ----
    if (p === "/api/messages" && req.method === "GET") {
      if (!state.sessionId) return json(res, 200, { messages: [] });
      try {
        const out = await oc(`/api/session/${state.sessionId}/message`);
        const msgs = (out.data || []).slice().reverse().map((m) => ({
          id: m.id, type: m.type, text: m.text, time: m.time,
          model: m.model, finish: m.finish, error: m.error,
          content: Array.isArray(m.content) ? m.content : undefined,
        }));
        return json(res, 200, { messages: msgs, sessionId: state.sessionId });
      } catch (e) { return fail(res, 502, e.message); }
    }

    // ---- opencode: abort the current turn ----
    if (p === "/api/abort" && req.method === "POST") {
      if (!state.sessionId) return json(res, 200, { ok: true });
      try { await oc(`/api/session/${state.sessionId}/abort`, { method: "POST" }); return json(res, 200, { ok: true }); }
      catch (e) { return fail(res, 502, e.message); }
    }

    // ---- opencode: approve permission requests from the agent ----
    if (p === "/api/permissions" && req.method === "GET") {
      try {
        const out = await oc(`/api/permission/request`);
        return json(res, 200, out.data || out);
      } catch { return json(res, 200, []); }
    }
    if (p === "/api/permissions/reply" && req.method === "POST") {
      const b = JSON.parse((await readBody(req, 1024 * 256)).toString("utf8") || "{}");
      const reply = b.reply || "once";
      if (!b.id) return fail(res, 400, "Permission id required");
      // The only route that actually answers is the session-scoped one; other
      // paths return an HTML page with a misleading 200.
      try {
        const sid = b.sessionID || state.sessionId;
        if (!sid) return fail(res, 400, "No session for this permission");
        await oc(`/api/session/${sid}/permission/${b.id}/reply`, { method: "POST", body: JSON.stringify({ reply }) });
        broadcast("permission_resolved", { id: b.id, reply });
        return json(res, 200, { ok: true });
      } catch (e) { return fail(res, 502, e.message); }
    }

    // ---- workflow catalogue ----
    if (p === "/api/workflows") {
      const files = fs.readdirSync(ROOT).filter((f) => f.endsWith(".json"));
      const out = [];
      for (const f of files) {
        try {
          const g = JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
          if (!Array.isArray(g.nodes) || !g.nodes.length) continue; // package.json, opencode.json, ...
          const types = [...new Set(g.nodes.map((n) => n.type))];
          const family = types.some((t) => /framepack/i.test(t)) ? "FramePack"
            : types.some((t) => /ltxv/i.test(t)) ? "LTX-Video"
            : types.some((t) => /controlnet/i.test(t)) ? "ControlNet"
            : types.some((t) => /savevideo|vhs_videocombine|createvideo/i.test(t)) ? "Video"
            : types.some((t) => /loadaudio|separation|saveaudiomp3|audio/i.test(t)) ? "Audio"
            : "SD1.5";
          const task = /SaveVideo|VHS_VideoCombine|FramePack|LTXV/i.test(types.join(",")) ? "Video"
            : family === "Audio" ? "Audio" : "Image";
          out.push({ file: f, family, task, nodes: g.nodes.length, types, imageInputs: findImageInputs(g), promptNodes: findPromptNodes(g).map((n) => n.id) });
        } catch { /* unparseable json - skip */ }
      }
      return json(res, 200, { workflows: out });
    }

    // ---- graph for the animated canvas ----
    if (p === "/api/workflow/graph") {
      const file = url.searchParams.get("file");
      if (!file) return fail(res, 400, "file required");
      const abs = path.join(ROOT, path.basename(file));
      if (!fs.existsSync(abs)) return fail(res, 404, "Workflow not found");
      const g = JSON.parse(fs.readFileSync(abs, "utf8"));
      let api = null;
      try {
        const oi = await (await fetch(`${COMFY_URL}/object_info`)).json();
        api = convertWorkflow(g, buildObjectInfoIndex(oi)).prompt;
      } catch {}
      if (currentRun && currentRun.graph === null) { currentRun.graph = g; currentRun.workflow = path.basename(file); }
      return json(res, 200, { file: path.basename(file), graph: g, api });
    }

    // ---- run a workflow directly (used by the GUI's Run/Retry buttons) ----
    if (p === "/api/comfy/run" && req.method === "POST") {
      const b = JSON.parse((await readBody(req, 20 * 1024 * 1024)).toString("utf8") || "{}");
      const abs = path.join(ROOT, path.basename(b.file || ""));
      if (!fs.existsSync(abs)) return fail(res, 404, "Workflow not found");
      const oi = await (await fetch(`${COMFY_URL}/object_info`)).json();
      const g = JSON.parse(fs.readFileSync(abs, "utf8"));
      const { prompt, warnings, missingTypes } = convertWorkflow(g, buildObjectInfoIndex(oi));

      // Apply edits the user/AI made in the GUI.
      if (b.edits) {
        for (const [nodeId, values] of Object.entries(b.edits)) {
          if (!prompt[nodeId]) continue;
          Object.assign(prompt[nodeId].inputs, values);
        }
      }
      const g0 = JSON.parse(fs.readFileSync(abs, "utf8"));
      const promptNodes = findPromptNodes(g0);
      const posNode = pickPositivePromptNode(promptNodes, b.promptNodeId);
      const negNode = pickNegativePromptNode(promptNodes, posNode);

      if (b.positive) {
        if (!posNode) return fail(res, 400, "This workflow has no prompt node to write into");
        prompt[String(posNode.id)].inputs.text = b.positive;
      }
      if (b.negative && negNode) {
        prompt[String(negNode.id)].inputs.text = b.negative;
      }
      if (b.seed === "random" || b.seed == null) {
        for (const n of Object.values(prompt)) if ("seed" in n.inputs && typeof n.inputs.seed === "number") n.inputs.seed = Math.floor(Math.random() * 2 ** 32);
      } else if (typeof b.seed === "number") {
        for (const n of Object.values(prompt)) if ("seed" in n.inputs) n.inputs.seed = b.seed;
      }

      const clientId = COMFY_CLIENT_ID;
      const r = await fetch(`${COMFY_URL}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, client_id: clientId }),
      });
      const out = await r.json();
      if (!r.ok) return fail(res, 400, "ComfyUI rejected the workflow", { nodeErrors: out.node_errors || out });

      currentRun = { promptId: out.prompt_id, startedAt: Date.now(), nodes: {}, graph: g, workflow: path.basename(abs) };
      broadcast("comfy_run_start", { promptId: out.prompt_id, workflow: path.basename(abs), graph: g });
      return json(res, 200, { promptId: out.prompt_id, warnings, missingTypes });
    }

    if (p === "/api/comfy/cancel" && req.method === "POST") {
      try { await fetch(`${COMFY_URL}/interrupt`, { method: "POST" }); return json(res, 200, { ok: true }); }
      catch (e) { return fail(res, 500, String(e.message)); }
    }

    if (p === "/api/comfy/queue") {
      try { const q = await (await fetch(`${COMFY_URL}/queue`)).json(); return json(res, 200, { running: q.queue_running || [], pending: q.queue_pending || [] }); }
      catch (e) { return fail(res, 502, String(e.message)); }
    }

    // ---- asset upload -> ComfyUI input ----
    if (p === "/api/upload" && req.method === "POST") {
      const raw = await readBody(req, 80 * 1024 * 1024);
      const name = path.basename(decodeURIComponent(url.searchParams.get("name") || `asset_${Date.now()}.png`));
      const dest = path.join(COMFY_INPUT, name);
      const copy = path.join(DATA, "uploads", name);
      fs.writeFileSync(dest, raw);
      fs.writeFileSync(copy, raw);
      const meta = await imageMeta(dest).catch(() => ({}));
      const saved = { name, bytes: raw.length, ...meta, savedAt: Date.now() };
      appendUpload(saved);
      broadcast("asset_uploaded", saved);
      return json(res, 200, saved);
    }

    if (p === "/api/assets" && req.method === "GET") {
      return json(res, 200, { assets: readUploads() });
    }

    // ---- projects: one folder per piece of work ----
    if (p === "/api/projects" && req.method === "GET") {
      const list = projects.list();
      return json(res, 200, { ...list, active: state.activeProject || "", dir: projects.PROJECTS_DIR });
    }

    if (p === "/api/projects" && req.method === "POST") {
      const body = await readBody(req, 1024 * 1024).then((b) => JSON.parse(b || "{}")).catch(() => ({}));
      const created = projects.create(body);
      if (created.error) return fail(res, 400, created.error);
      if (body.select !== false) { state.activeProject = created.slug; saveState(); }
      broadcast("projects_changed", { active: state.activeProject });
      return json(res, 200, created);
    }

    if (p === "/api/projects/select" && req.method === "POST") {
      const body = await readBody(req, 64 * 1024).then((b) => JSON.parse(b || "{}")).catch(() => ({}));
      const slug = String(body.slug || "");
      if (slug && !projects.readMeta(slug)) return fail(res, 404, `No project named "${slug}"`);
      state.activeProject = slug;
      saveState();
      broadcast("projects_changed", { active: state.activeProject });
      return json(res, 200, { active: state.activeProject });
    }

    if (p === "/api/projects/info" && req.method === "GET") {
      const info = projects.info({ project: url.searchParams.get("slug") });
      if (info.error) return fail(res, 404, info.error);
      const withUrls = {
        ...info,
        assets: info.assets.map((f) => ({ ...f, url: "/api/file?path=" + encodeURIComponent(f.path) })),
        results: info.results.map((f) => ({ ...f, url: "/api/file?path=" + encodeURIComponent(f.path) })),
      };
      return json(res, 200, withUrls);
    }

    // Move an already-uploaded file into the active project's assets.
    if (p === "/api/projects/asset" && req.method === "POST") {
      const body = await readBody(req, 64 * 1024).then((b) => JSON.parse(b || "{}")).catch(() => ({}));
      const slug = body.slug || state.activeProject;
      const src = path.join(DATA, "uploads", path.basename(String(body.name || "")));
      if (!fs.existsSync(src)) return fail(res, 404, "Upload it first, then add it to the project.");
      const added = projects.addAsset({ project: slug, sourcePath: src });
      if (added.error) return fail(res, 400, added.error);
      broadcast("projects_changed", { active: state.activeProject });
      return json(res, 200, added);
    }

    // Snapshot a project into its own git repo (and optionally GitHub).
    if (p === "/api/projects/publish" && req.method === "POST") {
      const body = await readBody(req, 64 * 1024).then((b) => JSON.parse(b || "{}")).catch(() => ({}));
      const slug = body.slug || state.activeProject;
      const r = await projects.publish({
        project: slug,
        create: body.create,
        visibility: body.visibility,
        includeAssets: body.includeAssets,
        message: body.message,
      });
      if (r.error) return fail(res, 400, r.error);
      broadcast("projects_changed", { active: state.activeProject });
      return json(res, 200, r);
    }

    // ---- results (ComfyUI output) ----
    if (p === "/api/results") {
      const limit = Number(url.searchParams.get("limit") || 24);
      const out = [];
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else { const st = fs.statSync(full); out.push({ name: e.name, path: full, mtime: st.mtimeMs, size: st.size, ext: path.extname(e.name).toLowerCase() }); }
        }
      };
      try { if (fs.existsSync(COMFY_OUTPUT)) walk(COMFY_OUTPUT); } catch {}
      out.sort((a, b) => b.mtime - a.mtime);
      return json(res, 200, { results: out.slice(0, limit).map((r) => ({ ...r, url: "/api/file?path=" + encodeURIComponent(r.path) })) });
    }

    // ---- serve a local file (images/videos for the GUI) ----
    if (p === "/api/file") {
      const target = decodeURIComponent(url.searchParams.get("path") || "");
      const abs = path.resolve(target);
      const allowed = [COMFY_OUTPUT, COMFY_INPUT, path.join(DATA, "uploads"), projects.PROJECTS_DIR];
      if (!allowed.some((a) => abs.startsWith(a))) return fail(res, 403, "Outside allowed folders");
      return serveFile(res, abs);
    }

    if (p === "/api/log" && req.method === "POST") {
      const b = (await readBody(req, 256 * 1024)).toString("utf8");
      log("client:", b.slice(0, 500));
      return json(res, 200, { ok: true });
    }

    // ---- apps registry (things the studio can do, built on request) ----
    if (p === "/api/apps" && req.method === "GET") {
      return json(res, 200, apps.listWithBuiltins());
    }

    const appRun = p.match(/^\/api\/apps\/([a-z0-9-]+)\/run$/);
    if (appRun && req.method === "POST") {
      const body = await readBody(req, 1024 * 1024).then((b) => JSON.parse(b || "{}")).catch(() => ({}));
      const r = await apps.run(appRun[1], body);
      return json(res, r.error ? 400 : 200, r);
    }

    // serve an app's own web page: /apps/<id>/index.html
    if (p.startsWith("/apps/")) {
      const rel = p.slice("/apps/".length).replace(/^\/+/, "");
      const abs = path.join(apps.APPS_DIR, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ""));
      if (!abs.startsWith(apps.APPS_DIR)) return fail(res, 403, "Outside app folder");
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return serveFile(res, abs);
      return fail(res, 404, "No such app page");
    }

    // ---- capability pool (what the studio can draw from) ----
    if (p === "/api/pool" && req.method === "GET") {
      // capabilities.pool() keeps its own 30s file cache shared with the CLI;
      // ?fresh=1 forces a re-probe.
      const pool = await capabilities.pool({ fresh: url.searchParams.get("fresh") === "1" });
      return json(res, 200, pool);
    }

    // ---- browser bridge: the AI's hands on websites ----
    if (p === "/api/web" && req.method === "POST") {
      const body = await readBody(req, 256 * 1024).then((b) => JSON.parse(b || "{}")).catch(() => ({}));
      const r = await browser.run(body.action, body);
      return json(res, r && r.error && !r.available ? 400 : 200, r);
    }
    if (p === "/api/connectors" && req.method === "GET") {
      return json(res, 200, { connectors: connectors.list() });
    }
    if (p === "/api/connectors" && req.method === "POST") {
      const body = await readBody(req, 256 * 1024).then((b) => JSON.parse(b || "{}")).catch(() => ({}));
      const r = connectors.save(body);
      return json(res, r.error ? 400 : 200, r);
    }
    // browser screenshots, served back to the GUI / the agent
    if (p.startsWith("/shots/")) {
      const name = path.basename(p.slice("/shots/".length));
      return serveFile(res, path.join(browser.SHOTS, name));
    }

    // ---- static GUI ----
    let rel = p === "/" ? "/index.html" : p;
    const abs = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ""));
    if (abs.startsWith(PUBLIC)) return serveFile(res, abs);
    return fail(res, 404, "Not found");
  } catch (e) {
    log("ERROR", p, e.message);
    if (!res.headersSent) return fail(res, e.status && e.status < 600 ? e.status : 500, e.message);
    try { res.end(); } catch {}
  }
});

// ---------- uploads store ----------
function uploadsFile() { return path.join(DATA, "uploads.json"); }
function readUploads() { try { return JSON.parse(fs.readFileSync(uploadsFile(), "utf8")); } catch { return []; } }
function appendUpload(item) {
  const list = readUploads();
  list.unshift(item);
  fs.writeFileSync(uploadsFile(), JSON.stringify(list.slice(0, 60), null, 2));
}
function imageMeta(file) {
  return new Promise((resolve) => {
    execFile(process.execPath, ["-e", `
      const fs=require('fs');const b=fs.readFileSync(process.argv[1]);
      if(b.slice(1,4).toString()==='PNG'){const w=b.readUInt32BE(16),h=b.readUInt32BE(20);console.log(JSON.stringify({w,h}));}
      else if(b[0]===0xFF&&b[1]===0xD8){let i=2;while(i<b.length){if(b[i]!==0xFF){i++;continue;}const m=b[i+1];if(m>=0xC0&&m<=0xCF&&m!==0xC4&&m!==0xC8&&m!==0xCC){console.log(JSON.stringify({h:b.readUInt16BE(i+5),w:b.readUInt16BE(i+7)}));return;}i+=2+b.readUInt16BE(i+2);}console.log('{}');}
      else console.log('{}');
    `, file], (err, stdout) => {
      if (err) return resolve({});
      try { resolve(JSON.parse(stdout.trim() || "{}")); } catch { resolve({}); }
    });
  });
}

// ---------- boot ----------
server.listen(PORT, "127.0.0.1", () => {
  log(`AI Studio listening on http://127.0.0.1:${PORT}`);
  log(`  workflows : ${ROOT}`);
  log(`  comfyui   : ${COMFY_URL}`);
  log(`  opencode  : http://127.0.0.1:${OPENCODE_PORT}`);
  connectComfy();
  ensureOpencode();
  broadcast("service", { name: "studio", state: "listening" });
});

// reaper: make sure opencode is up even if it dies while idle
setInterval(() => { if (!ocProc) ensureOpencode().catch(() => {}); }, 30000);

process.on("SIGINT", () => { try { ocStreamAbort && ocStreamAbort.abort(); } catch {}; process.exit(0); });
