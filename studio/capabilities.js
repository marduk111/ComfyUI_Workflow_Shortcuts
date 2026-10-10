"use strict";

// ============================================================
// Capability pool — every resource the studio can draw from.
//
// The agent consults this before building anything new: a GitHub
// repo to borrow code from, a Hugging Face model to download, a
// local Ollama/Hermes brain to think with, ComfyUI for image /
// video / audio generation, ffmpeg for media plumbing.
//
// Each entry answers three questions:
//   ready?   is it installed/running right now?
//   use?     the exact command or endpoint the agent should call
//   what?    one plain-English line about what it is good for
//
// `node studio/studio.js pool` prints all of it as one JSON object.
// ============================================================

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const COMFY_URL = process.env.COMFY_URL || "http://127.0.0.1:8188";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const OPENCODE_PORT = process.env.OPENCODE_PORT || 4097;
const COMFY_ROOT = process.env.COMFY_ROOT || "D:\\ComfyUI_windows_portable";

// The pool costs a few network probes and CLI calls to assemble, so results
// are cached briefly. Both the CLI (`pool`) and the GUI (/api/pool) share
// this file; pool_get invalidates it after an install.
const CACHE_FILE = path.join(__dirname, "data", ".pool_cache.json");
const CACHE_MS = 30000;

function invalidateCache() {
  try { fs.unlinkSync(CACHE_FILE); } catch {}
}

function which(exe) {
  return new Promise((resolve) => {
    const cmd = process.platform === "win32" ? "where" : "which";
    execFile(cmd, [exe], { windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout).split(/\r?\n/)[0].trim() || null);
    });
  });
}

async function probe(url, timeout = 2000) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

function runJson(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || "").slice(0, 300), err: err ? err.message : null });
    });
  });
}

// ---------- individual capability probes ----------

async function comfyui() {
  const up = await probe(`${COMFY_URL}/system_stats`);
  let version = null, nodes = null, vramFreeGB = null;
  if (up) {
    try {
      const s = await (await fetch(`${COMFY_URL}/system_stats`)).json();
      version = s.system && s.system.comfyui_version;
      const dev = (s.devices || [])[0];
      if (dev && dev.vram_free) vramFreeGB = +(dev.vram_free / 1e9).toFixed(2);
    } catch {}
    try {
      const oi = await (await fetch(`${COMFY_URL}/object_info`)).json();
      nodes = Object.keys(oi).length;
    } catch {}
  }
  const workflows = (() => {
    try {
      const root = path.resolve(__dirname, "..");
      return fs.readdirSync(root).filter((f) => f.endsWith(".json")).length;
    } catch { return 0; }
  })();
  return {
    id: "comfyui", name: "ComfyUI", ready: up,
    what: "Local image, video and audio generation on your own GPU.",
    use: "node studio/studio.js run <workflow.json> positive=\"...\"  then  wait",
    detail: { version, nodes, vramFreeGB, workflows },
  };
}

async function ollama() {
  const up = await probe(`${OLLAMA_URL}/api/tags`);
  let models = [];
  if (up) {
    try { models = ((await (await fetch(`${OLLAMA_URL}/api/tags`)).json()).models || []).map((m) => m.name); } catch {}
  }
  const hermes = models.filter((m) => /hermes/i.test(m));
  const speech = models.filter((m) => /speech|whisper|asr/i.test(m));
  return {
    id: "ollama", name: "Ollama", ready: up && models.length > 0,
    what: "Local language models — chat, planning, transcription. Nothing leaves the machine.",
    use: "node studio/studio.js ask model=<name> prompt=\"...\"",
    detail: { modelCount: models.length, models, hermes, speech },
  };
}

// Hermes is Nous Research's reasoning family. It runs through Ollama, so the
// pool reports it as its own entry with its own install path. Takes the ollama
// probe result so pool() only hits /api/tags once.
async function hermes(ollamaProbe) {
  const o = ollamaProbe || await ollama();
  const installed = (o.detail && o.detail.hermes) || [];
  return {
    id: "hermes", name: "Hermes (Nous Research)", ready: installed.length > 0,
    what: "Strong reasoning model for planning, code and structured work. Runs locally via Ollama.",
    use: installed.length
      ? `node studio/studio.js ask model=${installed[0]} prompt="..."`
      : 'node studio/studio.js pool_get capability=hermes  (downloads it, ~4.7 GB, one time)',
    detail: {
      installed,
      installCommand: "ollama pull hermes3:8b",
      fallbacks: (o.detail && o.detail.models || []).slice(0, 6),
    },
  };
}

async function huggingface() {
  const exe = await which("hf");
  let me = null, cached = 0;
  if (exe) {
    const r = await runJson(exe, ["whoami"], 15000);
    if (r.ok) {
      const m = r.stdout.match(/"name"\s*:\s*"([^"]+)"/) || r.stdout.match(/Logged in as ([^\s]+)/i);
      me = m ? m[1] : "yes";
    }
    const cache = path.join(process.env.LOCALAPPDATA || "", "huggingface", "hub");
    const cache2 = path.join(process.env.USERPROFILE || "", ".cache", "huggingface", "hub");
    for (const c of [cache, cache2]) {
      try { cached = Math.max(cached, fs.readdirSync(c).filter((d) => d.startsWith("models--")).length); } catch {}
    }
  }
  return {
    id: "huggingface", name: "Hugging Face", ready: !!exe,
    what: "Hundreds of thousands of ready-made AI models: audio, vision, language, embeddings.",
    use: 'node studio/studio.js hf action=search query="vocal separation"  |  action=download model="<owner>/<name>"',
    detail: { cli: exe, account: me, cachedModels: cached },
  };
}

async function github() {
  const exe = await which("gh");
  let me = null;
  if (exe) {
    const r = await runJson(exe, ["api", "user", "--jq", ".login"], 15000);
    if (r.ok) me = r.stdout.trim();
  }
  const git = await which("git");
  return {
    id: "github", name: "GitHub", ready: !!exe && !!git,
    what: "Borrow working code from public repositories — or publish what the studio builds.",
    use: 'node studio/studio.js gh action=search query="..."  |  action=clone repo="owner/name"',
    detail: { cli: exe, git, account: me },
  };
}

async function ffmpegCap() {
  const exe = await which("ffmpeg");
  let version = null;
  if (exe) {
    const r = await runJson(exe, ["-version"], 10000);
    const m = r.stdout.match(/ffmpeg version (\S+)/);
    version = m ? m[1] : "yes";
  }
  return {
    id: "ffmpeg", name: "ffmpeg", ready: !!exe,
    what: "Convert, cut, join and re-encode audio/video files.",
    use: 'node studio/studio.js media action=convert input="a.wav" output="a.mp3"',
    detail: { cli: exe, version },
  };
}

async function pythonCap() {
  const exe = await which("python") || await which("python3");
  // The ComfyUI embedded interpreter is the one with librosa/soundfile installed.
  const embedded = path.join(COMFY_ROOT, "python_embeded", "python.exe");
  const hasEmbedded = fs.existsSync(embedded);
  let ver = null;
  if (exe) {
    const r = await runJson(exe, ["--version"], 10000);
    ver = (r.stdout || r.stderr).trim();
  }
  return {
    id: "python", name: "Python", ready: !!exe || hasEmbedded,
    what: "Run Python scripts — including the scientific audio stack inside ComfyUI's own Python.",
    use: hasEmbedded
      ? `"${embedded}" script.py   (has librosa, soundfile, torch)`
      : "python script.py",
    detail: { cli: exe, version: ver, embedded: hasEmbedded ? embedded : null },
  };
}

async function comfyNodes() {
  const dir = path.join(COMFY_ROOT, "ComfyUI", "custom_nodes");
  let packs = [];
  try { packs = fs.readdirSync(dir).filter((d) => !d.startsWith(".") && fs.statSync(path.join(dir, d)).isDirectory()); } catch {}
  const modelsDir = path.join(COMFY_ROOT, "ComfyUI", "models");
  const modelFamilies = (() => {
    try { return fs.readdirSync(modelsDir).filter((d) => fs.statSync(path.join(modelsDir, d)).isDirectory()); } catch { return []; }
  })();
  return {
    id: "comfy-nodes", name: "ComfyUI node packs", ready: packs.length > 0,
    what: "Extra capabilities plugged into the generator (stem separation, video, upscaling…).",
    use: "Ask the studio to add a workflow that uses one of these packs.",
    detail: { packs, modelFamilies },
  };
}

// The chat brain itself — the model talking to the human through the GUI.
// Listed so the pool answers "where does the thinking come from" completely.
// Health check hits /api/health (same endpoint server.js uses). A 401 means
// the server IS up but requires the studio's basic-auth credentials — count
// that as ready, since the studio process holds those credentials itself.
async function opencode() {
  let up = false;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch(`http://127.0.0.1:${OPENCODE_PORT}/api/health`, { signal: ctl.signal });
    clearTimeout(t);
    up = r.ok || r.status === 401;
  } catch { up = false; }
  return {
    id: "opencode", name: "opencode (this AI)", ready: up,
    what: "The assistant chatting with you in the studio window — builds apps, runs tools, plans work.",
    use: "Just talk to it in the chat box. It can call every other capability here.",
    detail: { port: OPENCODE_PORT, url: up ? `http://127.0.0.1:${OPENCODE_PORT}` : null },
  };
}

// The studio's hands on the outside web: a real Edge browser with the
// human's logins, plus a registry of reverse-engineered API recipes.
async function webBridge() {
  const exe = process.platform === "win32"
    ? ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
       "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => fs.existsSync(p))
    : null;
  let playwright = false;
  try { require.resolve("playwright-core"); playwright = true; } catch {}
  let connectors = 0;
  try { connectors = fs.readdirSync(path.join(__dirname, "..", "connectors")).filter((f) => f.endsWith(".json")).length; } catch {}
  const up = await probe(`http://127.0.0.1:7860/api/connectors`, 1500).catch(() => false);
  return {
    id: "web-bridge", name: "Web bridge (browser + connectors)", ready: !!exe && playwright,
    what: "Use real websites as the logged-in human: open, click, read, screenshot — and record a site's API calls to reuse them directly.",
    use: 'node studio/studio.js web action=goto url="https://..."   then inspect/read/click/harvest',
    detail: { edge: exe || null, playwright, connectors, serverRoute: up ? "up" : "server may need a restart" },
  };
}

// ---------- pool assembly ----------

async function pool(opts = {}) {
  if (!opts.fresh) {
    try {
      const st = fs.statSync(CACHE_FILE);
      if (Date.now() - st.mtimeMs < CACHE_MS) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    } catch {}
  }
  // one ollama probe feeds both the ollama and hermes entries
  const ollamaProbe = await ollama();
  const caps = await Promise.all([
    comfyui(), Promise.resolve(ollamaProbe), hermes(ollamaProbe),
    huggingface(), github(), ffmpegCap(), pythonCap(), comfyNodes(), opencode(), webBridge(),
  ]);
  const out = {
    generatedAt: new Date().toISOString(),
    readyCount: caps.filter((c) => c.ready).length,
    total: caps.length,
    capabilities: caps,
  };
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(out));
  } catch {}
  return out;
}

// Install / fetch a capability on request. Only a small allowlist —
// never arbitrary shell. Used by `pool_get`.
async function get(id, opts = {}) {
  if (id === "hermes") {
    const model = opts.model || "hermes3:8b";
    const ollama = await which("ollama");
    if (!ollama) return { error: "Ollama is not installed, so Hermes cannot run." };
    const already = await hermes();
    if (already.ready) return { ok: true, already: already.detail.installed, hint: "Already available." };
    const r = await runJson(ollama, ["pull", model], 30 * 60 * 1000);
    if (!r.ok) return { error: "Download failed: " + (r.err || r.stderr) };
    invalidateCache();
    return { ok: true, model, note: "Hermes is ready. Use: node studio/studio.js ask model=" + model + " prompt=\"...\"" };
  }
  if (id === "huggingface-model") {
    const model = opts.model;
    if (!model) return { error: 'Give a model id, e.g. pool_get capability=huggingface-model model="openai/whisper-small"' };
    const hf = await which("hf");
    if (!hf) return { error: "The hf command-line tool is not installed." };
    const dest = opts.dest || path.join(COMFY_ROOT, "ComfyUI", "models", "huggingface");
    fs.mkdirSync(dest, { recursive: true });
    const r = await runJson(hf, ["download", model, "--local-dir", dest], 30 * 60 * 1000);
    if (!r.ok) return { error: "Download failed: " + (r.err || r.stderr) };
    invalidateCache();
    return { ok: true, model, dest, note: `Saved under ${dest}` };
  }
  return { error: `Nothing to fetch for "${id}". Try: hermes | huggingface-model` };
}

module.exports = { pool, get, invalidateCache };
