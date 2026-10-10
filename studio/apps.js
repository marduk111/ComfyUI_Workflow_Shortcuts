"use strict";

// App registry — the studio's "universe" of small tools and AI agents.
//
// Every app is a folder under apps/ with a manifest.json:
//
//   {
//     "id": "stem-splitter",
//     "name": "Stem Splitter",
//     "kind": "agent",                     // agent | tool | effect
//     "description": "Splits a song into vocals/drums/bass/other.",
//     "source": { "type": "comfyui", "ref": "AUDIO_Stems_Split.json" },
//     "run": { "type": "node", "entry": "run.js", "timeoutMs": 600000 },
//     "inputs": [ { "name": "audio", "label": "Song file", "type": "audio" } ]
//   }
//
// run.js receives one JSON object of arguments as argv[2] (for run.py it is
// argv[1], since Python's argv[0] is the script itself) and must print one
// JSON object to stdout. An optional apps/<id>/index.html is served at
// /apps/<id>/index.html and shows up in the studio's Apps dropdown.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const APPS_DIR = path.join(ROOT, "apps");

const BUILTINS = [
  {
    id: "plugins",
    name: "Plugins",
    kind: "builtin",
    description: "Play and export the audio effects this studio has built.",
    web: { page: "/plugin.html" },
  },
];

function validId(id) {
  return /^[a-z0-9][a-z0-9-]{1,48}$/.test(String(id || ""));
}
function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}
function dirFor(id) {
  return path.join(APPS_DIR, id);
}

function readManifest(id) {
  const f = path.join(dirFor(id), "manifest.json");
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}

function list() {
  if (!fs.existsSync(APPS_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(APPS_DIR)) {
    if (!validId(name)) continue;
    const m = readManifest(name);
    if (!m) continue;
    out.push(entryFrom(name, m));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// One manifest -> one dropdown/CLI entry. Shared by list() and get() so a
// single app never needs a full directory scan to describe itself.
function entryFrom(id, m) {
  const page = path.join(dirFor(id), "index.html");
  return {
    id,
    name: m.name || id,
    kind: m.kind || "tool",
    description: m.description || "",
    source: m.source || null,
    inputs: m.inputs || [],
    web: fs.existsSync(page) ? { page: `/apps/${id}/index.html` } : null,
    run: m.run ? { type: m.run.type || "node", entry: m.run.entry || "run.js" } : null,
    createdAt: m.createdAt || null,
    createdBy: m.createdBy || null,
  };
}

function listWithBuiltins() {
  return { builtins: BUILTINS, apps: list() };
}

function get(id) {
  if (!validId(id)) return null;
  const m = readManifest(id);
  return m ? entryFrom(id, m) : null;
}

// Stubs declare themselves so a test run of an unwritten app is obviously
// incomplete instead of looking like a working result.
const STUB_RUN = `"use strict";
// App runner stub — receives JSON args on argv[2], prints one JSON object.
// Replace this with the real task: call Ollama, ComfyUI, HuggingFace, GitHub…
const args = JSON.parse(process.argv[2] || "{}");
console.log(JSON.stringify({ stub: true, received: args, note: "run.js is still the stub — write the real logic, then app_run again" }));
`;

const STUB_PY = `import json, sys
# App runner stub — receives JSON args on argv[1] (Python's argv[0] is the
# script itself, unlike Node where argv[1] is the script), prints one JSON object.
args = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
print(json.dumps({"stub": True, "received": args, "note": "run.py is still the stub — write the real logic, then app_run again"}))
`;

function create(a = {}) {
  const id = slug(a.id || a.name);
  if (!validId(id)) return { error: "Need a name/id with letters, numbers and dashes (e.g. stem-splitter)." };
  const dir = dirFor(id);
  const existed = fs.existsSync(path.join(dir, "manifest.json"));
  fs.mkdirSync(dir, { recursive: true });

  const prev = readManifest(id) || {};
  const runType = a.runType || (prev.run && prev.run.type) || "node";
  const defaultEntry = runType === "python" ? "run.py" : "run.js";
  const manifest = {
    id,
    name: a.name || prev.name || id,
    kind: a.kind || prev.kind || "tool",
    description: a.description || prev.description || "",
    source: a.sourceType
      ? { type: a.sourceType, ref: a.sourceRef || "", url: a.sourceUrl || "" }
      : (prev.source || { type: "local", ref: "", url: "" }),
    run: {
      type: runType,
      entry: a.entry || (prev.run && prev.run.entry) || defaultEntry,
      timeoutMs: a.timeoutMs || (prev.run && prev.run.timeoutMs) || 600000,
    },
    inputs: a.inputs || prev.inputs || [],
    createdAt: prev.createdAt || new Date().toISOString(),
    createdBy: prev.createdBy || "agent",
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const entryPath = path.join(dir, manifest.run.entry);
  if (!fs.existsSync(entryPath)) fs.writeFileSync(entryPath, runType === "python" ? STUB_PY : STUB_RUN);

  const page = path.join(dir, "index.html");
  return {
    id,
    created: !existed,
    path: path.relative(ROOT, dir),
    entry: manifest.run.entry,
    web: fs.existsSync(page) ? `/apps/${id}/index.html` : null,
    hint: fs.existsSync(page)
      ? `Open ${`/apps/${id}/index.html`}. Run it with: node studio/studio.js app_run id=${id}`
      : `Write ${manifest.run.entry} (print one JSON object), then test: node studio/studio.js app_run id=${id}`,
  };
}

function remove(id) {
  if (!validId(id)) return { error: "bad id" };
  const dir = dirFor(id);
  if (!fs.existsSync(dir)) return { error: `No app named "${id}"` };
  fs.rmSync(dir, { recursive: true, force: true });
  return { removed: id };
}

// Run an app's entry script. Only ever executes files inside apps/<id>/.
function run(id, args = {}) {
  const app = get(id);
  if (!app) return { error: `No app named "${id}". Try: node studio/studio.js apps` };
  if (!app.run) return { error: `App "${id}" has no run block in its manifest.` };
  const dir = dirFor(id);
  const entry = path.join(dir, app.run.entry);
  const rootApps = APPS_DIR + path.sep;
  if (!entry.startsWith(rootApps)) return { error: "runner escaped the app folder" };
  if (!fs.existsSync(entry)) return { error: `${app.run.entry} is missing in apps/${id}/` };

  // Prefer the ComfyUI embedded Python (has librosa/soundfile/torch) over a
  // bare `python` on PATH, which on Windows may be a Store stub.
  let runtime = process.execPath;
  if (app.run.type === "python") {
    runtime = process.env.STUDIO_PYTHON ||
      path.join("D:\\ComfyUI_windows_portable", "python_embeded", "python.exe");
    if (!fs.existsSync(runtime)) runtime = "python";
  }
  const timeout = app.run.timeoutMs || 600000;
  const started = Date.now();

  return new Promise((resolve) => {
    execFile(runtime, [entry, JSON.stringify(args || {})],
      { cwd: ROOT, timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const elapsed = Date.now() - started;
        const out = String(stdout || "").trim();
        let parsed = null;
        // tolerate trailing log lines: take the last line that parses as JSON
        for (const line of out.split(/\r?\n/).reverse()) {
          const t = line.trim();
          if (t.startsWith("{") || t.startsWith("[")) {
            try { parsed = JSON.parse(t); break; } catch {}
          }
        }
        if (parsed) {
          const res = { app: id, elapsedMs: elapsed, result: parsed };
          // promote in-script errors so callers (CLI exit code, HTTP status,
          // agent) see failure the same way as a crash — one signal, not two
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.error) {
            res.error = parsed.error;
          }
          if (err && err.killed) res.warning = "hit the time limit";
          if (stderr && String(stderr).trim()) res.stderr = String(stderr).trim().slice(-800);
          return resolve(res);
        }
        resolve({
          app: id, elapsedMs: elapsed,
          error: (err ? (err.killed ? "time limit reached — " + err.message : err.message) : "no JSON on stdout"),
          stdout: out.slice(-1200),
          stderr: String(stderr || "").trim().slice(-800),
        });
      });
  });
}

module.exports = { list, listWithBuiltins, get, create, remove, run, APPS_DIR, ROOT, validId, slug };
