"use strict";

// Shared ComfyUI operations.
// Used by two front doors:
//   - studio/mcp-comfyui.js  (MCP stdio server, works in `opencode run` CLI)
//   - studio/studio.js       (plain CLI, used by the agent via `bash`, works everywhere)
// opencode 1.18.29 does not expose MCP or custom tools to models in `serve`
// mode, so the CLI below is the path the GUI's agent actually takes.

const fs = require("fs");
const path = require("path");

const COMFY = process.env.COMFY_URL || "http://127.0.0.1:8188";
const ROOT = path.resolve(__dirname, "..");
const INPUT_DIR = process.env.COMFY_INPUT || "D:\\ComfyUI_windows_portable\\ComfyUI\\input";
const OUTPUT_DIR = process.env.COMFY_OUTPUT || "D:\\ComfyUI_windows_portable\\ComfyUI\\output";
const MODELS_DIR = process.env.COMFY_MODELS || "D:\\ComfyUI_windows_portable\\ComfyUI\\models";
const LAST_RUN_FILE = path.join(__dirname, "data", ".last_run.json");
// Must match server.js's websocket client_id or ComfyUI won't stream
// execution events to the GUI's animation panel.
const CLIENT_ID = "ai-studio";

const { convertWorkflow, buildObjectInfoIndex, findImageInputs, findPromptNodes, pickPositivePromptNode, pickNegativePromptNode } = require("./convert.js");
const projects = require("./projects.js");

let specIndex = null;
let objectInfo = null;

async function loadObjectInfo() {
  if (objectInfo) return;
  objectInfo = await (await fetch(`${COMFY}/object_info`)).json();
  specIndex = buildObjectInfoIndex(objectInfo);
}

async function comfy(pathname, opts = {}) {
  const res = await fetch(`${COMFY}${pathname}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`ComfyUI ${pathname} -> ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body).slice(0, 800)}`);
  return body;
}

function listWorkflowFiles() {
  return fs.readdirSync(ROOT).filter((f) => f.endsWith(".json")).map((f) => {
    try {
      const g = JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
      const nodes = (g.nodes || []).map((n) => n.type);
      const families = new Set();
      for (const n of nodes) {
        if (/framepack/i.test(n)) families.add("FramePack");
        else if (/ltxv/i.test(n)) families.add("LTX-Video");
        else if (/controlnet/i.test(n)) families.add("ControlNet");
        else if (/savevideo|vhs_/i.test(n)) families.add("Video");
      }
      const prompts = findPromptNodes(g);
      return {
        file: f,
        nodes: nodes.length,
        families: [...families],
        nodeTypes: [...new Set(nodes)].slice(0, 14),
        imageInputs: findImageInputs(g),
        promptNodes: prompts.map((p) => ({ id: p.id, role: p.role })),
        missingOnServer: [],
      };
    } catch (e) {
      return { file: f, error: String(e.message) };
    }
  });
}

// In-memory edits: `run` uses these so the saved workflow library is never
// rewritten behind the user's back. The file-writing variants below exist for
// the explicit set_prompt / set_image commands.
function applyPromptToGraph(g, positive, negative, promptNodeId) {
  const prompts = findPromptNodes(g);
  if (!prompts.length) return { error: "Workflow has no CLIPTextEncode prompt nodes" };
  const target = pickPositivePromptNode(prompts, promptNodeId);
  if (!target) return { error: `No prompt node ${promptNodeId}`, available: prompts };
  const node = g.nodes.find((n) => n.id === target.id);
  const idx = (node.widgets_values || []).findIndex((v) => typeof v === "string");
  if (idx < 0) node.widgets_values.push(positive); else node.widgets_values[idx] = positive;
  let negativeSet = false;
  if (negative) {
    const other = pickNegativePromptNode(prompts, target);
    if (other) {
      const on = g.nodes.find((n) => n.id === other.id);
      const oi = (on.widgets_values || []).findIndex((v) => typeof v === "string");
      if (oi >= 0) { on.widgets_values[oi] = negative; negativeSet = true; }
    }
  }
  return { updated: true, promptNodeId: target.id, negativeSet };
}

function applyImageToGraph(g, filename, nodeId) {
  const targets = (g.nodes || []).filter((n) => /loadimage|imageupload/i.test(n.type));
  const node = nodeId != null ? targets.find((n) => String(n.id) === String(nodeId)) : targets[0];
  if (!node) return { error: "Workflow has no LoadImage node" };
  const idx = (node.widgets_values || []).findIndex((v) => typeof v === "string");
  if (idx < 0) return { error: "LoadImage node has no filename widget" };
  node.widgets_values[idx] = filename;
  return { updated: true, nodeId: node.id, filename };
}

function setPrompt(workflow, positive, negative, promptNodeId) {
  const file = path.join(ROOT, path.basename(workflow));
  if (!fs.existsSync(file)) return { error: `No workflow named ${workflow}` };
  const g = JSON.parse(fs.readFileSync(file, "utf8"));
  const res = applyPromptToGraph(g, positive, negative, promptNodeId);
  if (res.error) return res;
  fs.writeFileSync(file, JSON.stringify(g, null, 2));
  return { ...res, file: path.basename(file) };
}

function setImage(workflow, filename, nodeId) {
  const file = path.join(ROOT, path.basename(workflow));
  if (!fs.existsSync(file)) return { error: `No workflow named ${workflow}` };
  const g = JSON.parse(fs.readFileSync(file, "utf8"));
  const res = applyImageToGraph(g, filename, nodeId);
  if (res.error) return res;
  fs.writeFileSync(file, JSON.stringify(g, null, 2));
  return { ...res, file: path.basename(file) };
}

const TOOLS = {
  status: {
    description: "Check whether the local ComfyUI server is running, plus queue depth and GPU/VRAM state. Call this first if anything seems stuck.",
    async run() {
      try {
        const stats = await comfy("/system_stats");
        const q = await comfy("/queue");
        const dev = (stats.devices || [])[0] || {};
        return {
          running: true,
          version: stats.system.comfyui_version,
          gpu: dev.name,
          vramFreeGB: dev.vram_free ? +(dev.vram_free / 1e9).toFixed(2) : null,
          queueRunning: (q.queue_running || []).length,
          queuePending: (q.queue_pending || []).length,
        };
      } catch (e) {
        return { running: false, error: String(e.message) };
      }
    },
  },

  list: {
    description: "List every saved workflow the user can run (text-to-image, image-to-image, ControlNet pose, FramePack/LTX image-to-video).",
    async run() {
      await loadObjectInfo();
      return { workflows: listWorkflowFiles() };
    },
  },

  describe: {
    description: "Inspect one workflow: node ids, widget values, prompt nodes and LoadImage nodes.",
    args: "<workflow.json>",
    async run({ workflow }) {
      await loadObjectInfo();
      const file = path.join(ROOT, path.basename(workflow));
      if (!fs.existsSync(file)) return { error: `No workflow named ${workflow}` };
      const g = JSON.parse(fs.readFileSync(file, "utf8"));
      const { prompt, warnings, missingTypes } = convertWorkflow(g, specIndex);
      return {
        file: path.basename(file),
        nodeCount: Object.keys(prompt).length,
        missingTypes,
        warnings,
        imageInputs: findImageInputs(g),
        promptNodes: findPromptNodes(g),
        nodes: (g.nodes || []).map((n) => ({
          id: n.id,
          type: n.type,
          widgets: n.widgets_values || [],
          inputs: (n.inputs || []).map((i) => i.name),
        })),
      };
    },
  },

  set_prompt: {
    description: "Rewrite the positive (and optionally negative) text prompt inside a saved workflow.",
    args: '<workflow.json> {"positive":"...","negative":"..."}',
    async run(a) {
      if (!a.positive) return { error: "positive prompt is required" };
      return setPrompt(a.workflow, a.positive, a.negative, a.promptNodeId);
    },
  },

  set_image: {
    description: "Point a workflow's LoadImage node at an image already in ComfyUI's input folder.",
    args: '<workflow.json> {"filename":"photo.png"}',
    async run(a) {
      return setImage(a.workflow, a.filename, a.nodeId);
    },
  },

  run: {
    description: "Queue a workflow on the local GPU. Returns prompt_id. The GUI animates the nodes live while it runs.",
    args: '<workflow.json> {"positive":"...","steps":12,"image":"photo.png","seed":"random"}',
    async run(args) {
      await loadObjectInfo();
      const file = path.join(ROOT, path.basename(args.workflow));
      if (!fs.existsSync(file)) return { error: `No workflow named ${args.workflow}` };
      if (args.project && !projects.readMeta(args.project)) {
        return { error: `No project named "${args.project}". Run: node studio/studio.js projects` };
      }
      const g = JSON.parse(fs.readFileSync(file, "utf8"));

      // Edits are applied to the in-memory graph only; the saved workflow file
      // stays exactly as the user last saved it.
      if (args.positive || args.negative) {
        const r = applyPromptToGraph(g, args.positive, args.negative, args.promptNodeId);
        if (r.error) return r;
      }
      if (args.image) {
        const r = applyImageToGraph(g, args.image);
        if (r.error) return r;
      }

      const built = convertWorkflow(g, specIndex);
      const p = built.prompt;

      // Everything that ends up changing the graph is echoed back under "applied"
      // so the agent can confirm its settings actually took effect.
      const applied = {};
      const markApplied = (key, hit) => { if (hit) applied[key] = args[key]; };

      if (args.seed != null) {
        const seed = args.seed === "random" || args.seed === "" ? Math.floor(Math.random() * 2 ** 32) : Number(args.seed);
        let hit = false;
        for (const node of Object.values(p)) {
          if (node.inputs.seed === "random") { node.inputs.seed = seed; hit = true; }
          else if (typeof node.inputs.seed === "number" && args.seed !== "keep") { node.inputs.seed = seed; hit = true; }
        }
        markApplied("seed", hit);
        if (hit) applied.seed = seed;
      }
      if (args.steps != null) {
        let hit = false;
        for (const node of Object.values(p)) if ("steps" in node.inputs) { node.inputs.steps = Number(args.steps); hit = true; }
        markApplied("steps", hit);
      }
      if (args.width != null || args.height != null) {
        let hitW = false;
        let hitH = false;
        for (const node of Object.values(p)) {
          if ("width" in node.inputs && args.width != null) { node.inputs.width = Number(args.width); hitW = true; }
          if ("height" in node.inputs && args.height != null) { node.inputs.height = Number(args.height); hitH = true; }
        }
        markApplied("width", hitW);
        markApplied("height", hitH);
      }
      // positive/negative/image are applied above and abort the call on failure,
      // so reaching here means they took effect.
      if (args.positive) applied.positive = args.positive;
      if (args.negative) applied.negative = args.negative;
      if (args.image) applied.image = args.image;
      if (args.project) applied.project = args.project;

      // Anything else (denoise, cfg, length, frame_count, ...) is applied to every
      // node that has an input of that name, keeping the original value's type.
      const RESERVED = new Set(["workflow", "positive", "negative", "image", "seed", "steps", "width", "height", "promptNodeId", "project"]);
      for (const [key, raw] of Object.entries(args)) {
        if (RESERVED.has(key) || raw == null || raw === "") continue;
        let hit = false;
        for (const node of Object.values(p)) {
          if (!(key in node.inputs)) continue;
          const cur = node.inputs[key];
          let val = raw;
          if (typeof cur === "number") val = Number(raw);
          else if (typeof cur === "boolean") val = raw === true || raw === "true" || raw === "1";
          if (val === cur) continue;
          if (typeof val === "number" && !isFinite(val)) continue;
          node.inputs[key] = val;
          hit = true;
        }
        if (hit) applied[key] = raw;
      }

      const res = await fetch(`${COMFY}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: p, client_id: CLIENT_ID }),
      });
      const out = await res.json();
      if (!res.ok) return { error: `ComfyUI rejected the workflow: ${JSON.stringify(out).slice(0, 1200)}`, nodeErrors: out.node_errors || {} };
      try {
        fs.writeFileSync(LAST_RUN_FILE, JSON.stringify({ prompt_id: out.prompt_id, workflow: path.basename(file), at: Date.now(), project: args.project || null }));
      } catch {}
      return {
        queued: true,
        prompt_id: out.prompt_id,
        applied,
        nodeErrors: out.node_errors || {},
        warnings: built.warnings,
        missingTypes: built.missingTypes,
        workflow: path.basename(file),
      };
    },
  },

  queue: {
    description: "Check what ComfyUI is running and what is waiting.",
    async run() {
      const q = await comfy("/queue");
      return {
        running: (q.queue_running || []).map((x) => ({ prompt_id: x[1] })),
        pending: (q.queue_pending || []).map((x) => ({ prompt_id: x[1] })),
      };
    },
  },

  wait: {
    description: "Block until the queue is empty (with a timeout), then report whether the last run succeeded or failed, including the ComfyUI error. Pass project=<slug> to file the result into that project's folder.",
    args: '{"prompt_id":"...","timeout":180}',
    async run(a = {}) {
      const timeout = Number(a.timeout || 180) * 1000;
      const started = Date.now();
      for (;;) {
        const q = await comfy("/queue");
        const busy = (q.queue_running || []).length + (q.queue_pending || []).length;
        if (busy) {
          if (Date.now() - started > timeout) return { done: false, timeout: true, stillRunning: busy };
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        break;
      }
      const elapsedSec = Math.round((Date.now() - started) / 1000);
      let last = null;
      if (fs.existsSync(LAST_RUN_FILE)) {
        try { last = JSON.parse(fs.readFileSync(LAST_RUN_FILE, "utf8")); } catch {}
      }
      const promptId = a.prompt_id || (last && last.prompt_id);
      if (!promptId) return { done: true, elapsedSec };
      const h = await comfy(`/history/${promptId}`).catch(() => null);
      const rec = h && h[promptId];
      if (!rec) return { done: true, elapsedSec, prompt_id: promptId, note: "No history record for this run (it may have been evicted)." };
      const st = rec.status || {};
      const err = (st.messages || []).find((m) => m[0] === "execution_error");
      const produced = Object.keys(rec.outputs || {});
      if (err) {
        const e = err[1] || {};
        return {
          done: false, elapsedSec, prompt_id: promptId, status: "error",
          node: `${e.node_type || ""} (id ${e.node_id || "?"})`,
          error: String(e.exception_message || e.exception_type || "unknown error").trim(),
        };
      }
      const result = { done: true, elapsedSec, prompt_id: promptId, status: st.status_str || "success", outputs: produced };

      // If this run belongs to a project, file the output away in its folder.
      const project = a.project || (last && last.project);
      if (project && last && last.at) {
        try {
          const files = projects.allOutputFiles(OUTPUT_DIR);
          const saved = projects.collectResults({ project, files, since: last.at - 5000 });
          if (saved.error) result.project_warning = saved.error;
          else if (saved.copied) result.project = { slug: saved.project, copied: saved.copied, results: saved.results };
        } catch (e) {
          result.project_warning = String(e.message || e);
        }
      }
      return result;
    },
  },

  outputs: {
    description: "List the newest files ComfyUI has produced (images and videos) with full paths.",
    args: '{"limit":12}',
    async run({ limit = 12 } = {}) {
      const out = [];
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else out.push({ name: e.name, path: full, mtime: fs.statSync(full).mtimeMs, size: fs.statSync(full).size });
        }
      };
      if (fs.existsSync(OUTPUT_DIR)) walk(OUTPUT_DIR);
      out.sort((a, b) => b.mtime - a.mtime);
      return { outputDir: OUTPUT_DIR, files: out.slice(0, limit) };
    },
  },

  models: {
    description: "List which AI models are actually installed locally (checkpoints, LoRAs, video models, VAEs).",
    async run() {
      const out = {};
      for (const dir of ["checkpoints", "loras", "diffusion_models", "text_encoders", "vae", "clip_vision", "controlnet", "upscale_models"]) {
        const p = path.join(MODELS_DIR, dir);
        if (!fs.existsSync(p)) continue;
        out[dir] = fs.readdirSync(p).filter((f) => !/^put_/i.test(f));
      }
      return out;
    },
  },

  upload: {
    description: "Copy an image from disk into ComfyUI's input folder so a workflow can load it.",
    args: '<sourcePath> [newName]',
    async run(a) {
      const sourcePath = a.sourcePath;
      if (!sourcePath || !fs.existsSync(sourcePath)) return { error: `File not found: ${sourcePath}` };
      const name = a.newName || path.basename(sourcePath);
      const dest = path.join(INPUT_DIR, name);
      fs.copyFileSync(sourcePath, dest);
      return { uploaded: true, filename: name, path: dest };
    },
  },

  /* ---------------- projects: one folder per piece of work ---------------- */

  projects: {
    description: "List every project folder (assets + workflows + results).",
    async run() {
      const r = projects.list();
      if (r.projects && !r.projects.length) {
        r.hint = 'No projects yet. Make one: node studio/studio.js project_new name="My First Project"';
      }
      return r;
    },
  },

  project_new: {
    description: "Create a project folder for one piece of work.",
    args: 'name="Music video" description="..." workflow="SD15_Text2Img.json"',
    async run(a) {
      if (a.name == null && a._pos) a.name = a._pos;
      const r = projects.create(a);
      if (r.error) return r;
      r.hint = `Assets go in ${path.join(r.path, "assets")} - or add one with: node studio/studio.js project_add project=${r.slug} sourcePath="C:\\\\path\\\\to\\\\photo.jpg"`;
      return r;
    },
  },

  project_info: {
    description: "Show one project with its assets, workflows and results.",
    args: 'project="my-first-project"',
    async run(a) {
      if (a.project == null && a._pos) a.project = a._pos;
      return projects.info(a);
    },
  },

  project_add: {
    description: "Copy a file into a project's assets and into ComfyUI's input (so run image=<name> works).",
    args: '<sourcePath> project="my-project" [name="photo.jpg"]',
    async run(a) {
      if (a.sourcePath == null && a._pos) {
        const [src, ...rest] = a._pos.split(" ");
        a.sourcePath = src;
        if (rest.length && a.name == null && a.project == null) a.name = rest.join(" ");
      }
      const r = projects.addAsset(a);
      if (r.error) return r;
      r.hint = r.comfyInput
        ? `Now usable as: run <workflow> image=${r.filename} project=${r.project}`
        : `Copied into the project (ComfyUI input folder unavailable).`;
      return r;
    },
  },

  project_collect: {
    description: "Copy generator output into a project's results folder.",
    args: 'project="my-project" [since=<ms timestamp>]',
    async run(a) {
      const files = projects.allOutputFiles(OUTPUT_DIR);
      return projects.collectResults({ project: a.project, files, since: a.since });
    },
  },

  project_publish: {
    description: "Snapshot a project into its own git repository. create=true also publishes it to GitHub (asks GitHub, so only on request).",
    args: 'project="my-project" [create=true] [visibility=public|private] [message="..."] [includeAssets=true]',
    async run(a) {
      if (a.project == null && a._pos) a.project = a._pos;
      return projects.publish(a);
    },
  },
};

module.exports = { TOOLS, comfy, listWorkflowFiles, setPrompt, setImage, loadObjectInfo, ROOT, INPUT_DIR, OUTPUT_DIR, CLIENT_ID, projects };
