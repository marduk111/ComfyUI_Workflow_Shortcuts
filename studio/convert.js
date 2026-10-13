"use strict";

// Converts ComfyUI "litegraph" workflow JSON (the visual graph format saved
// from the ComfyUI canvas) into the "API format" that /prompt accepts.
//
// litegraph:  { nodes:[{id,type,pos,inputs,widgets_values,...}], links:[[id,fromNode,fromSlot,toNode,toSlot,type],...] }
// api:        { "5": {class_type:"KSampler", inputs:{seed:42, model:["1",0], ...}}, ... }
//
// Node IDs are preserved so the GUI can animate the visual graph while the
// server tracks execution by the same IDs.

const SOCKET_TYPE_RE = /^(MODEL|CLIP|VAE|CONDITIONING|LATENT|IMAGE|MASK|CONTROL_NET|GUIDER|SAMPLER|SIGMAS|NOISE|GLIGEN|STYLE_MODEL|UPSCALE_MODEL|CLIP_VISION|WEBCAM|AUDIO|MESH|IMAGEUPLOAD|LAYER_STYLE)$/i;

// ComfyUI object_info tells widgets and sockets apart by shape, not by name:
// widgets are primitives, option lists, or carry a default. Everything else is a
// socket - which also catches union/file/custom types like VHS_BatchManager,
// FramePackMODEL or "FILE_3D_GLB,FILE_3D_FBX" that a name heuristic gets wrong.
function isWidgetInput(type, opts) {
  if (Array.isArray(type)) return true; // combo list of values
  if (type && typeof type === "object") return false;
  const t = String(type);
  if (/^(INT|FLOAT|STRING|BOOLEAN|COMBO)$/i.test(t)) return true;
  if (opts && (Array.isArray(opts.options) || opts.default !== undefined)) return true;
  return false;
}

function isSocketType(type) {
  if (Array.isArray(type)) return false;
  if (type && typeof type === "object") return false;
  const t = String(type);
  if (/^(INT|FLOAT|STRING|BOOLEAN|COMBO)$/i.test(t)) return false;
  if (SOCKET_TYPE_RE.test(t)) return true;
  return /^[A-Z][A-Z0-9_]*$/.test(t);
}

// Does a saved widget value plausibly belong to this input?
function typeOk(entry, value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(entry.type) || (entry.opts && Array.isArray(entry.opts.options))) {
    // Dropdown selections are strings (or numeric keys) - never booleans.
    return typeof value === "string" || typeof value === "number";
  }
  const t = String(entry.type);
  if (t === "BOOLEAN") return typeof value === "boolean";
  if (t === "INT" || t === "FLOAT") return typeof value === "number" && isFinite(value);
  if (t === "STRING") return typeof value === "string";
  return true;
}

function buildObjectInfoIndex(objectInfo) {
  const index = new Map();
  const entryFor = (name, v, optional) => {
    const type = Array.isArray(v) ? v[0] : v;
    const opts = (Array.isArray(v) && v[1]) || {};
    return { name, type, opts, socket: !isWidgetInput(type, opts), optional };
  };
  for (const [cls, def] of Object.entries(objectInfo || {})) {
    const required = (def.input && def.input.required) || {};
    const optional = (def.input && def.input.optional) || {};
    const spec = [];
    for (const [name, v] of Object.entries(required)) spec.push(entryFor(name, v, false));
    for (const [name, v] of Object.entries(optional)) spec.push(entryFor(name, v, true));
    index.set(cls, spec);
  }
  return index;
}

function convertWorkflow(graph, specIndex) {
  const prompt = {};
  const warnings = [];
  const missingTypes = new Set();

  const linksById = new Map();
  for (const link of graph.links || []) {
    if (Array.isArray(link)) linksById.set(link[0], link);
    else if (link && link.id != null) linksById.set(link.id, link);
  }

  for (const node of graph.nodes || []) {
    const cls = node.type;
    const spec = specIndex.get(cls);
    if (!spec) {
      missingTypes.add(cls);
      warnings.push(`Node ${node.id} (${cls}) has no definition on this ComfyUI server - skipped.`);
      continue;
    }

    const inputs = {};

    // 1. Sockets: wire connections from other nodes.
    for (const inp of node.inputs || []) {
      if (inp.link == null) continue;
      const link = linksById.get(inp.link);
      if (!link) continue;
      const fromNode = Array.isArray(link) ? link[1] : link.origin_id;
      const fromSlot = Array.isArray(link) ? link[2] : link.origin_slot;
      inputs[inp.name] = [String(fromNode), fromSlot];
    }

    // 2. Widgets: primitive values saved alongside the node.
    const mapped = mapWidgets(node.widgets_values, spec, inputs);
    for (const w of mapped.warnings) warnings.push(`Node ${node.id} (${cls}): ${w}`);

    // 3. Schema drift: a workflow saved on another ComfyUI version can be missing
    //    required inputs (SaveVideo gained a `codec` field). Fill them with the
    //    node's own default so /prompt doesn't reject the whole graph.
    for (const entry of spec) {
      if (entry.socket || entry.optional) continue;
      if (inputs[entry.name] !== undefined) continue;
      const d = defaultFor(entry);
      if (d === undefined) continue;
      inputs[entry.name] = d;
      warnings.push(`Node ${node.id} (${cls}): input "${entry.name}" was absent from the saved workflow - filled with its default ${JSON.stringify(d)}.`);
    }

    prompt[String(node.id)] = { class_type: cls, inputs };
  }

  return { prompt, warnings, missingTypes: [...missingTypes] };
}

// Maps a node's saved widget values (positional array or {name:value} map)
// onto its declared inputs. `inputs` is pre-seeded with socket connections -
// widget values never overwrite a wired socket. Returns the widget-name ->
// value/index map so callers that need to EDIT a specific widget (quality
// tuning) write to exactly the slot convertWorkflow reads back.
function mapWidgets(values, spec, inputs) {
  const warnings = [];
  const index = {};
  const widgets = spec.filter((e) => !e.socket);

  if (values && !Array.isArray(values) && typeof values === "object") {
    for (const entry of widgets) {
      if (entry.name in values) {
        if (inputs[entry.name] === undefined) inputs[entry.name] = values[entry.name];
        index[entry.name] = entry.name;
      }
    }
    return { warnings, index, objectStyle: true };
  }

  const list = Array.isArray(values) ? values : [];
  let wi = 0;
  let shifted = false;
  for (const entry of widgets) {
    if (inputs[entry.name] !== undefined) continue;
    if (wi >= list.length) break;
    // A graph saved on another node version can have shifted widgets, so take
    // the first remaining value that actually fits this input's type.
    let idx = -1;
    for (let i = wi; i < list.length; i++) if (typeOk(entry, list[i])) { idx = i; break; }
    if (idx === -1) break;
    if (idx > wi) shifted = true;
    const value = list[idx];
    inputs[entry.name] = value;
    index[entry.name] = idx;
    let next = idx + 1;
    const trailing = list[next];
    // ComfyUI saves a hidden "randomize/fixed" widget right after a seed, but
    // not every node declares control_after_generate, so also detect it by value.
    const hasControl = (entry.opts && entry.opts.control_after_generate) ||
      (/seed/i.test(entry.name) && typeof value === "number" && typeof trailing === "string" &&
        /^(randomize|fixed|increment|decrement)$/.test(trailing));
    if (hasControl) next++;
    wi = next;
  }

  // Version drift: the graph holds more widget values than this node now
  // declares (VHS gained pix_fmt/crf and later lost them). Only when a
  // shift was actually detected, re-anchor the tail so trailing flags such
  // as save_output land on the right values.
  if (shifted && list.length > widgets.length && widgets.length) {
    const n = widgets.length;
    const m = list.length;
    let r = 0;
    for (let k = 1; k <= Math.min(n, m); k++) {
      let ok = true;
      for (let j = 0; j < k; j++) if (!typeOk(widgets[n - 1 - j], list[m - 1 - j])) { ok = false; break; }
      if (!ok) break;
      r = k;
    }
    const changed = [];
    for (let j = 0; j < r; j++) {
      const e = widgets[n - 1 - j];
      const v = list[m - 1 - j];
      if (inputs[e.name] !== v) changed.push(`${e.name}: ${JSON.stringify(inputs[e.name])} -> ${JSON.stringify(v)}`);
      inputs[e.name] = v;
      index[e.name] = m - 1 - j;
    }
    if (changed.length) warnings.push(`saved widgets are shifted for this node version - realigned ${changed.join(", ")}.`);
  }

  return { warnings, index, objectStyle: false };
}

// Best-effort value for a widget input the saved graph did not provide.
function defaultFor(entry) {
  const o = entry.opts || {};
  if (o.default !== undefined) return o.default;
  if (Array.isArray(entry.type) && entry.type.length) return entry.type[0];
  const opts = o.options;
  if (Array.isArray(opts) && opts.length) {
    const first = opts[0];
    if (first && typeof first === "object") return "key" in first ? first.key : undefined;
    return first;
  }
  if (typeof entry.type === "string") {
    if (entry.type === "BOOLEAN") return false;
    if (entry.type === "INT" || entry.type === "FLOAT") return 0;
  }
  return undefined;
}

// Saved widget values arrive either as a positional array or (newer graphs)
// as a {name:value} map - normalize to a value list for scanning.
function widgetValueList(node) {
  const values = node.widgets_values;
  if (Array.isArray(values)) return values;
  if (values && typeof values === "object") return Object.values(values);
  return [];
}

// Reads an uploaded filename out of any LoadImage-style node so the caller can
// tell the GUI which assets the workflow expects.
function findImageInputs(graph) {
  const names = new Set();
  for (const node of graph.nodes || []) {
    if (!/loadimage|loadvideo|loadaudio|imageupload/i.test(node.type)) continue;
    for (const v of widgetValueList(node)) if (typeof v === "string" && v.trim()) names.add(v);
  }
  return [...names];
}

// Find the prompt-bearing CLIPTextEncode nodes so the GUI/agent can rewrite them.
//
// role is decided by tracing links into the sampler: whichever input of the
// sampler this node feeds (`positive` / `negative`) wins. Guessing from text
// length is wrong - in many workflows the negative prompt is the short one, so
// a naive "shortest wins" rule silently overwrites the negative prompt.
function findPromptNodes(graph) {
  const linksById = new Map();
  for (const link of graph.links || []) {
    if (Array.isArray(link)) linksById.set(link[0], link);
    else if (link && link.id != null) linksById.set(link.id, link);
  }

  // toNodeId -> Map(inputName -> fromNodeId)
  const feeders = new Map();
  for (const node of graph.nodes || []) {
    const m = new Map();
    for (const inp of node.inputs || []) {
      if (inp.link == null) continue;
      const link = linksById.get(inp.link);
      if (!link) continue;
      const fromNode = Array.isArray(link) ? link[1] : link.origin_id;
      m.set(inp.name, fromNode);
    }
    feeders.set(node.id, m);
  }

  const out = [];
  for (const node of graph.nodes || []) {
    if (node.type !== "CLIPTextEncode") continue;
    const values = widgetValueList(node);
    const text = values.find((v) => typeof v === "string") || "";

    let role = null;
    for (const [, m] of feeders) {
      for (const [inputName, fromId] of m) {
        if (fromId !== node.id) continue;
        if (/positive/i.test(inputName)) role = "positive";
        else if (/negative/i.test(inputName) && role !== "positive") role = "negative";
      }
    }
    if (!role) {
      // Fallback: hand-labelled node titles.
      const title = String(node.title || node.properties?.title || "");
      if (/positive|\bprompt\b|\btext\b/i.test(title)) role = "positive";
      else if (/negative|unwanted|bad/i.test(title)) role = "negative";
    }

    out.push({ id: node.id, text: text || "", role, title: node.title || null });
  }
  return out;
}

// Picks the node a `positive` prompt should be written into.
//  1. explicit id,  2. anything marked positive,  3. the longest text as last resort.
function pickPositivePromptNode(prompts, promptNodeId) {
  if (!prompts.length) return null;
  if (promptNodeId != null) {
    const hit = prompts.find((p) => String(p.id) === String(promptNodeId));
    if (hit) return hit;
  }
  const positive = prompts.filter((p) => p.role === "positive");
  if (positive.length === 1) return positive[0];
  if (positive.length > 1) return positive.slice().sort((a, b) => (b.text || "").length - (a.text || "").length)[0];
  return prompts.slice().sort((a, b) => (b.text || "").length - (a.text || "").length)[0];
}

// Picks the node a `negative` prompt should be written into.
function pickNegativePromptNode(prompts, positiveNode) {
  if (!prompts.length) return null;
  const negative = prompts.filter((p) => p.role === "negative");
  if (negative.length) return negative[0];
  return prompts.find((p) => positiveNode && p.id !== positiveNode.id) || null;
}

module.exports = { convertWorkflow, buildObjectInfoIndex, findImageInputs, findPromptNodes, pickPositivePromptNode, pickNegativePromptNode, isSocketType, widgetValueList, mapWidgets };
