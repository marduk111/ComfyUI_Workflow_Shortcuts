"use strict";

// Workflow quality engine: audits saved workflows against best practices for
// this machine (RTX 3050 6GB, SD1.5 checkpoints), builds new workflows with
// better settings (DPM++ 2M Karras, hires fix second pass), and applies
// fixes to a copy of an existing workflow (originals are never touched).

const { convertWorkflow, findPromptNodes, mapWidgets } = require("./convert.js");

const GOOD_SAMPLERS = new Set(["dpmpp_2m", "dpmpp_2m_sde", "dpmpp_sde", "dpm_2", "heun", "euler", "lms", "dpm_adaptive", "dpmpp_2m_cfg_pp"]);
const GOOD_SCHEDULERS = new Set(["karras", "exponential", "simple", "sgm_uniform", "beta"]);
const ANCESTRAL_SAMPLERS = /ancestral|sde|heunpp|uni_pc/i;

const QUALITY_NEGATIVE =
  "blurry, low quality, lowres, jpeg artifacts, deformed, disfigured, bad anatomy, extra limbs, extra fingers, mutated hands, watermark, text, signature, oversaturated, cropped, worst quality, normal quality";

const PRESETS = {
  draft:    { steps: 16, cfg: 6.0, hires: false, p2Steps: 0,  p2Denoise: 0 },
  balanced: { steps: 24, cfg: 6.5, hires: true,  p2Steps: 14, p2Denoise: 0.45 },
  max:      { steps: 32, cfg: 7.0, hires: true,  p2Steps: 20, p2Denoise: 0.40 },
};

function detectFamily(graph) {
  const types = (graph.nodes || []).map((n) => String(n.type));
  const has = (re) => types.some((t) => re.test(t));
  if (has(/loadaudio|audioband|separation|saveaudiomp3|audioequalizer|audiocrop|audioconcat|audiospeed|audioadjust|audiocombine/i)) return "audio";
  if (has(/framepack/i)) return "framepack";
  if (has(/ltxv/i)) return "ltx";
  if (has(/savevideo|vhs_videocombine|createvideo/i)) return "video";
  if (has(/checkpointloadersimple/i) && (has(/^kSampler$/i) || has(/samplercustom/i))) return "image";
  return "unknown";
}

function widgetsOf(node, specIndex) {
  const spec = specIndex.get(node.type);
  if (!spec) return {};
  const inputs = {};
  mapWidgets(node.widgets_values, spec, inputs);
  return inputs;
}

function installedCheckpoints(objectInfo) {
  const entry = objectInfo && objectInfo.CheckpointLoaderSimple;
  const opts = entry && entry.input && entry.input.required && entry.input.required.ckpt_name;
  return (Array.isArray(opts) && Array.isArray(opts[0])) ? opts[0] : [];
}

function findNodes(graph, re) {
  return (graph.nodes || []).filter((n) => re.test(String(n.type)));
}

function issue(sev, where, text, fix) {
  return { severity: sev, where, issue: text, fix };
}

/* ---------------- audit ---------------- */

function auditWorkflow(graph, ctx) {
  const { specIndex, objectInfo } = ctx;
  const family = detectFamily(graph);
  const issues = [];
  const nodeCount = (graph.nodes || []).length;

  if (!nodeCount) {
    return { family, score: 0, grade: "broken", issues: [issue("high", "-", "File has no nodes - not a workflow graph.", "Re-export it from ComfyUI or rebuild it with wf_build.")], summary: "This file is not a workflow." };
  }

  if (family === "audio") {
    if (!findNodes(graph, /^loadaudio$|^vhs_loadaudio$/i).length) {
      issues.push(issue("high", "input", "No LoadAudio node - nothing to edit.", 'Point it at a song with: set_audio <file> filename="song.mp3"'));
    }
    return finishAudit(family, issues, nodeCount, "Audio workflows on this machine are already tuned - only structural problems are checked.");
  }

  if (family === "framepack" || family === "ltx" || family === "video") {
    const lat = findNodes(graph, /emptyltxvlatentvideo|emptylatentimage/i)[0];
    if (lat) {
      const v = widgetsOf(lat, specIndex);
      if (v.width && v.height && v.width * v.height > 768 * 768) {
        issues.push(issue("med", `node ${lat.id} (${lat.type})`, `Video canvas is ${v.width}x${v.height} - heavy for a 6 GB graphics card.`, "Run with base_resolution=512 or length kept low."));
      }
    }
    const stepsNode = findNodes(graph, /^kSampler$|^FramePackSampler$/i)[0];
    if (stepsNode) {
      const v = widgetsOf(stepsNode, specIndex);
      if (v.steps > 30) issues.push(issue("low", `node ${stepsNode.id}`, `${v.steps} sampling steps - video here is already slow.`, "15-25 steps is the sweet spot on this PC."));
    }
    return finishAudit(family, issues, nodeCount, "Video workflow - checked size and step budget for the 6 GB card.");
  }

  if (family !== "image") {
    return finishAudit(family, issues, nodeCount, "Unrecognized workflow type - only structural checks were run.");
  }

  const ckpts = installedCheckpoints(objectInfo);
  const ckptNode = findNodes(graph, /CheckpointLoaderSimple/i)[0];
  if (!ckptNode) {
    issues.push(issue("high", "-", "No model loader node found.", "Rebuild with: wf_build task=t2i"));
  } else {
    const v = widgetsOf(ckptNode, specIndex);
    if (v.ckpt_name && ckpts.length && !ckpts.includes(v.ckpt_name)) {
      issues.push(issue("high", `node ${ckptNode.id}`, `Model "${v.ckpt_name}" is not installed.`, `Available: ${ckpts.join(", ")}`));
    }
    if (/ltxv|framepack|hunyuan/i.test(v.ckpt_name || "")) {
      issues.push(issue("med", `node ${ckptNode.id}`, `"${v.ckpt_name}" is a video model - wrong for image workflows.`, "Use dreamshaper_8.safetensors or SD_1.5_for_reals_v11.safetensors."));
    }
  }

  const task = findNodes(graph, /emptylatentimage/i).length ? "t2i" : "i2i";
  const mainSampler = findNodes(graph, /^kSampler$/i)[0];
  if (!mainSampler && !findNodes(graph, /samplercustom/i).length) {
    issues.push(issue("high", "-", "No sampling node - this cannot draw anything.", "Rebuild with: wf_build task=" + task));
  }

  if (mainSampler) {
    const v = widgetsOf(mainSampler, specIndex);
    const where = `node ${mainSampler.id} (KSampler)`;

    if (v.sampler_name && (!GOOD_SAMPLERS.has(String(v.sampler_name)) || !GOOD_SCHEDULERS.has(String(v.scheduler)))) {
      issues.push(issue("med", where,
        `Sampler "${v.sampler_name}" with "${v.scheduler}" scheduler produces softer, less detailed images.`,
        "Use dpmpp_2m with the karras scheduler - sharper detail at the same speed."));
    }
    if (ANCESTRAL_SAMPLERS.test(String(v.sampler_name || "")) && v.steps < 20) {
      issues.push(issue("med", where, `"${v.sampler_name}" stays noisy at only ${v.steps} steps.`, "Either switch to dpmpp_2m, or raise steps to 25+."));
    }
    if (v.steps != null && v.steps < 16) {
      issues.push(issue("med", where, `Only ${v.steps} steps - details will look unfinished.`, "16 steps for drafts, 24-32 for quality."));
    } else if (v.steps != null && v.steps > 40) {
      issues.push(issue("low", where, `${v.steps} steps - very slow on this card with little visible gain.`, "32 is the practical ceiling for SD1.5."));
    }
    if (v.cfg != null && v.cfg < 4) {
      issues.push(issue("med", where, `CFG ${v.cfg} - the AI largely ignores your prompt.`, "CFG 5-8 follows the prompt while staying natural."));
    } else if (v.cfg != null && v.cfg > 10) {
      issues.push(issue("med", where, `CFG ${v.cfg} - expect burnt, oversaturated colors.`, "CFG 5-8."));
    }
    if (task === "i2i") {
      if (v.denoise != null && v.denoise < 0.2) issues.push(issue("low", where, `Denoise ${v.denoise} - your photo will barely change.`, "0.4-0.7 for a visible restyle."));
      if (v.denoise != null && v.denoise > 0.85) issues.push(issue("med", where, `Denoise ${v.denoise} - the original photo is basically thrown away.`, "0.5-0.7 keeps the composition but applies the style."));
    }
  }

  const latent = findNodes(graph, /emptylatentimage/i)[0];
  if (latent && task === "t2i") {
    const v = widgetsOf(latent, specIndex);
    const w = v.width || 0, h = v.height || 0, batch = v.batch_size || 1;
    const where = `node ${latent.id} (canvas)`;
    if (w % 8 || h % 8) {
      issues.push(issue("high", where, `${w}x${h} is not a multiple of 8 - ComfyUI may refuse to run it.`, "Use 512x512, 640x640, 768x768, etc."));
    } else if (w * h > 768 * 768) {
      issues.push(issue("med", where, `${w}x${h} is risky on a 6 GB card - may run out of memory.`, "512x512 base plus a hires second pass is the safe way to get big images."));
    } else if (w < 512 || h < 512) {
      issues.push(issue("low", where, `${w}x${h} output is small and soft.`, "512x512 base, then let the hires pass enlarge it."));
    }
    if (batch > 1) {
      issues.push(issue("med", where, `Batch of ${batch} multiplies memory use.`, "batch_size=1 on this card; queue several runs with seed=random instead."));
    }
  }

  if (!findNodes(graph, /latentupscaleby|imageupscale|upscalelatent/i).length) {
    issues.push(issue("low", "detail", "No enlargement/refine pass - the final image stays at base size with softer detail.", "A second sampling pass at 1.5x size sharpens faces, textures and small details."));
  }

  const prompts = safePrompts(graph);
  const neg = prompts.find((p) => p.role === "negative");
  if (!prompts.length) {
    issues.push(issue("high", "-", "No text prompt nodes found.", "Rebuild with: wf_build task=" + task));
  } else if (neg && (neg.text || "").trim().length < 40) {
    issues.push(issue("low", `node ${neg.id}`, "Negative prompt is too thin to prevent artifacts (blurry spots, extra fingers, text overlays).", "Use the standard quality negative prompt - wf_improve adds it for you."));
  }

  return finishAudit(family, issues, nodeCount, null);
}

function safePrompts(graph) {
  try { return findPromptNodes(graph) || []; } catch { return []; }
}

function finishAudit(family, issues, nodeCount, note) {
  const weights = { high: 25, med: 10, low: 4, info: 0 };
  let score = 100;
  for (const i of issues) score -= weights[i.severity] || 0;
  score = Math.max(0, Math.min(100, score));
  const grade = score >= 90 ? "excellent" : score >= 75 ? "good" : score >= 40 ? "fair" : "poor";
  const order = { high: 0, med: 1, low: 2, info: 3 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  const summary = issues.length
    ? `${issues.length} issue${issues.length > 1 ? "s" : ""} found (score ${score}/100). Top fix: ${issues[0].fix}`
    : `No issues found - this workflow already follows best practices (score ${score}/100).`;
  return { family, nodeCount, score, grade, issues, summary, note: note || undefined };
}

/* ---------------- improve ---------------- */

function improveWorkflow(graph, ctx, opts = {}) {
  const { specIndex } = ctx;
  const family = detectFamily(graph);
  const changes = [];
  if (family !== "image") {
    return { graph, changes, skipped: `wf_improve only tunes image workflows (this is "${family}").` };
  }

  const mainSampler = findNodes(graph, /^kSampler$/i)[0];
  if (mainSampler) {
    const spec = specIndex.get(mainSampler.type);
    const wv = mainSampler.widgets_values;
    const inputs = {};
    const { index } = mapWidgets(wv, spec, inputs);

    const setWidget = (name, value, why) => {
      if (inputs[name] === value) return;
      const before = inputs[name];
      inputs[name] = value;
      if (Array.isArray(wv) && typeof index[name] === "number") wv[index[name]] = value;
      else if (wv && !Array.isArray(wv) && typeof wv === "object") wv[name] = value;
      changes.push(`node ${mainSampler.id} ${name}: ${JSON.stringify(before)} -> ${JSON.stringify(value)} (${why})`);
    };

    if (inputs.sampler_name && !GOOD_SAMPLERS.has(String(inputs.sampler_name))) {
      setWidget("sampler_name", "dpmpp_2m", "sharper detail at the same speed");
    }
    if (inputs.scheduler && !GOOD_SCHEDULERS.has(String(inputs.scheduler))) {
      setWidget("scheduler", "karras", "cleaner convergence than normal/linear");
    }
    if (inputs.steps != null) {
      if (inputs.steps < 16) setWidget("steps", 24, "16+ steps so details finish rendering");
      else if (inputs.steps > 40) setWidget("steps", 32, "32 is the practical ceiling for SD1.5");
    }
    if (inputs.cfg != null) {
      if (inputs.cfg < 4) setWidget("cfg", 6.5, "follows the prompt without burning colors");
      else if (inputs.cfg > 10) setWidget("cfg", 7, "stops oversaturation");
    }
    if (opts.steps != null) setWidget("steps", Number(opts.steps), "requested step count");
    if (opts.cfg != null) setWidget("cfg", Number(opts.cfg), "requested CFG");
    if (opts.sampler) setWidget("sampler_name", String(opts.sampler), "requested sampler");
    if (opts.scheduler) setWidget("scheduler", String(opts.scheduler), "requested scheduler");
    if (opts.denoise != null) setWidget("denoise", Number(opts.denoise), "requested denoise");
  }

  const prompts = safePrompts(graph);
  const neg = prompts.find((p) => p.role === "negative");
  if (neg && (neg.text || "").trim().length < 40) {
    const node = (graph.nodes || []).find((n) => n.id === neg.id);
    if (node) {
      const wv = node.widgets_values;
      if (Array.isArray(wv)) {
        const idx = wv.findIndex((v) => typeof v === "string");
        if (idx >= 0) { wv[idx] = QUALITY_NEGATIVE; changes.push(`node ${node.id} negative prompt: filled in the standard quality negative`); }
      } else if (wv && typeof wv === "object") {
        for (const k of Object.keys(wv)) if (typeof wv[k] === "string") { wv[k] = QUALITY_NEGATIVE; changes.push(`node ${node.id} negative prompt: filled in the standard quality negative`); break; }
      }
    }
  }

  if (opts.hires && family === "image") {
    const r = insertHiresPass(graph, specIndex);
    if (r.error) changes.push(`hires pass not added: ${r.error}`);
    else if (r.added) changes.push(`added a 1.5x refine pass (new nodes ${r.nodes.join(", ")}) - sharper final detail`);
  }

  return { graph, changes };
}

// Splits sampler -> VAE decode into sampler -> upscale -> 2nd sampler ->
// decode, reusing the first sampler's prompt wiring. Only handles the simple
// shape (one KSampler wired straight into a VAEDecode) - refuses otherwise.
function insertHiresPass(graph, specIndex) {
  const sampler = findNodes(graph, /^kSampler$/i)[0];
  if (!sampler) return { error: "no KSampler found" };
  if (findNodes(graph, /latentupscaleby/i).length) return { added: false, reason: "already has one" };

  const decode = findNodes(graph, /^VAEDecode(Tiled)?$/i).find((d) => feedsFrom(graph, d, sampler.id));
  if (!decode) return { error: "the VAE decode is not fed directly by the sampler - not a simple graph, add the pass by hand" };
  if (!(graph.links || []).every((l) => Array.isArray(l))) return { error: "this file uses a link format wf_improve cannot edit safely" };

  // the old sampler -> decode link becomes sampler -> upscale
  const oldLink = graph.links.find((l) => l[1] === sampler.id && l[3] === decode.id);
  if (!oldLink) return { error: "could not find the sampler-to-decode connection" };

  const sInputs = {};
  const { index: sIdx } = mapWidgets(sampler.widgets_values, specIndex.get(sampler.type) || [], sInputs);
  const p2Steps = Math.max(10, Math.round((sInputs.steps || 24) * 0.6));

  let maxNode = Math.max(...graph.nodes.map((n) => n.id));
  let maxLink = Math.max(...graph.links.map((l) => l[0]));
  const upId = ++maxNode;
  const ks2Id = ++maxNode;
  const pos = sampler.pos || [0, 0];
  const orderBase = graph.nodes.reduce((m, n) => Math.max(m, n.order || 0), 0);

  // ks2 widgets: copy of ks1 with fewer steps + hires denoise
  let ks2Wv;
  if (Array.isArray(sampler.widgets_values)) {
    ks2Wv = sampler.widgets_values.slice();
    if (typeof sIdx.steps === "number") ks2Wv[sIdx.steps] = p2Steps;
    if (typeof sIdx.denoise === "number") ks2Wv[sIdx.denoise] = 0.45;
    else ks2Wv.push(0.45);
  } else {
    ks2Wv = { ...sampler.widgets_values, steps: p2Steps, denoise: 0.45 };
  }

  const upNode = {
    id: upId, type: "LatentUpscaleBy",
    pos: [pos[0] + 375, pos[1]], size: [315, 82],
    flags: {}, order: orderBase + 1, mode: 0,
    inputs: [{ name: "samples", type: "LATENT", link: oldLink[0] }],
    outputs: [{ name: "LATENT", type: "LATENT", links: [], slot_index: 0 }],
    properties: { "Node name for S&R": "LatentUpscaleBy" },
    widgets_values: ["bicubic", 1.5],
  };

  const ks2Inputs = (sampler.inputs || []).map((i) => ({ name: i.name, type: i.type, link: null }));
  const ks2Node = {
    id: ks2Id, type: sampler.type,
    pos: [pos[0] + 750, pos[1]], size: [...(sampler.size || [315, 262])],
    flags: {}, order: orderBase + 2, mode: 0,
    inputs: ks2Inputs,
    outputs: [{ name: "LATENT", type: "LATENT", links: [], slot_index: 0 }],
    properties: { "Node name for S&R": sampler.type },
    widgets_values: ks2Wv,
    color: sampler.color, bgcolor: sampler.bgcolor,
  };

  graph.nodes.push(upNode, ks2Node);

  // helper: fresh link from -> to (by target input name), returns link id
  const wire = (fromNode, fromSlot, toNode, toInputName) => {
    const inIdx = (toNode.inputs || []).findIndex((i) => i.name === toInputName);
    if (inIdx < 0) return null;
    const out = (fromNode.outputs || [])[fromSlot];
    const type = out ? out.type : "LATENT";
    const id = ++maxLink;
    graph.links.push([id, fromNode.id, fromSlot, toNode.id, inIdx, type]);
    toNode.inputs[inIdx].link = id;
    if (out) out.links.push(id);
    return id;
  };

  // model/prompt fan-out into ks2 (fresh links from the same sources)
  const src = (name) => {
    const inId = (sampler.inputs || []).find((i) => i.name === name && i.link != null);
    if (!inId) return null;
    const l = graph.links.find((x) => x[0] === inId.link);
    return l ? graph.nodes.find((n) => n.id === l[1]) : null;
  };
  if (src("model")) wire(src("model"), 0, ks2Node, "model");
  if (src("positive")) wire(src("positive"), 0, ks2Node, "positive");
  if (src("negative")) wire(src("negative"), 0, ks2Node, "negative");

  // reroute: old link retargets sampler -> upscale
  oldLink[3] = upId; oldLink[4] = 0;
  const l1 = wire(upNode, 0, ks2Node, "latent_image");
  const decodeIn = (decode.inputs || []).find((i) => i.name === "samples");
  const decodeSlot = decodeIn ? decode.inputs.indexOf(decodeIn) : 0;
  const l2 = ++maxLink;
  graph.links.push([l2, ks2Id, 0, decode.id, decodeSlot, "LATENT"]);
  if (decodeIn) decodeIn.link = l2;

  graph.last_node_id = Math.max(graph.last_node_id || 0, ks2Id);
  graph.last_link_id = Math.max(graph.last_link_id || 0, maxLink);

  return { added: true, nodes: [upId, ks2Id], links: [l1, l2] };
}

function feedsFrom(graph, target, srcId) {
  const ids = new Set();
  for (const l of graph.links || []) {
    const arr = Array.isArray(l) ? l : null;
    if (arr && arr[3] === target.id) ids.add(arr[1]);
  }
  return ids.has(srcId);
}

/* ---------------- build ---------------- */

function buildWorkflow(ctx, opts) {
  const { specIndex, objectInfo } = ctx;
  const task = String(opts.task || "t2i").toLowerCase().replace("text2img", "t2i").replace("image2img", "i2i");
  if (task !== "t2i" && task !== "i2i") {
    return { error: `task must be t2i (text to image) or i2i (photo to image) - got "${opts.task}". Video/audio workflows are curated by hand.` };
  }
  const quality = String(opts.quality || "balanced").toLowerCase();
  const preset = PRESETS[quality];
  if (!preset) return { error: `quality must be draft, balanced or max - got "${opts.quality}"` };

  const ckpts = installedCheckpoints(objectInfo);
  let model = opts.model ? String(opts.model) : "";
  if (!model) model = ckpts.includes("dreamshaper_8.safetensors") ? "dreamshaper_8.safetensors" : (ckpts[0] || "");
  if (model && ckpts.length && !ckpts.includes(model)) {
    return { error: `Model "${model}" is not installed. Available: ${ckpts.join(", ")}` };
  }

  const samplerSpec = specIndex.get("KSampler");
  if (!samplerSpec) return { error: "This ComfyUI install has no KSampler node" };
  const samplerList = widgetOptions(samplerSpec, "sampler_name");
  const schedList = widgetOptions(samplerSpec, "scheduler");
  const sampler = samplerList.includes("dpmpp_2m") ? "dpmpp_2m" : samplerList[0];
  const scheduler = schedList.includes("karras") ? "karras" : schedList[0];

  const width = normSize(opts.width, 512);
  const height = normSize(opts.height, 512);
  if (width * height > 768 * 768) {
    return { error: `${width}x${height} is too big for the 6 GB card - max base size is 768x768 (the hires pass enlarges the result for you).` };
  }

  const graph = graphT2I(task, {
    model, sampler, scheduler,
    steps: preset.steps, cfg: preset.cfg,
    hires: preset.hires, p2Steps: preset.p2Steps, p2Denoise: preset.p2Denoise,
    width, height,
    positive: opts.positive ? String(opts.positive) : "a cozy wooden cabin in a snowy pine forest at night, warm glowing golden windows, soft falling snow, moonlight, stars, peaceful winter scene, highly detailed, cinematic lighting, sharp focus",
    negative: opts.negative ? String(opts.negative) : QUALITY_NEGATIVE,
    seed: opts.seed != null && opts.seed !== "random" ? Number(opts.seed) : 42,
    denoise: opts.denoise != null ? Number(opts.denoise) : 0.65,
    image: opts.image ? String(opts.image) : "example.png",
    prefix: `SD15_${task}_${quality}`,
  });

  const { warnings, missingTypes } = convertWorkflow(graph, specIndex);
  if (missingTypes.length) return { error: `This ComfyUI install is missing nodes: ${missingTypes.join(", ")}`, warnings };

  const audit = auditWorkflow(graph, ctx);
  const file = `${task === "t2i" ? "SD15_Text2Img" : "SD15_Image2Img"}_${quality[0].toUpperCase() + quality.slice(1)}.json`;
  return {
    file, task, quality, model, sampler, scheduler,
    steps: preset.steps, cfg: preset.cfg, hires: preset.hires,
    width, height, graph, warnings, audit,
    note: preset.hires
      ? `Two passes: draw at ${width}x${height}, then enlarge 1.5x and refine (${width * 1.5}x${height * 1.5} final). Expect ~${estimateSeconds(preset)}s per image on this card.`
      : `Single pass at ${width}x${height}. Expect ~${estimateSeconds(preset)}s per image - fast draft settings.`,
  };
}

function estimateSeconds(p) {
  const base = p.steps * 0.45;
  return Math.round(p.hires ? base + p.p2Steps * 1.0 + 3 : base + 1);
}

function widgetOptions(spec, name) {
  const e = spec.find((x) => x.name === name);
  if (!e) return [];
  if (Array.isArray(e.type)) return e.type;
  if (e.opts && Array.isArray(e.opts.options)) return e.opts.options;
  return [];
}

function normSize(v, dflt) {
  if (v == null || v === "") return dflt;
  const n = Math.round(Number(v));
  if (!isFinite(n) || n < 256) return dflt;
  return Math.max(256, Math.floor(n / 8) * 8);
}

/* graph builder: nodes + links with wiring done by input name */

function graphT2I(task, c) {
  const nodes = [];
  const links = [];
  let nid = 0, lid = 0;

  const add = (type, pos, size, widgets, inputs, outputs) => {
    const n = {
      id: ++nid, type, pos, size, flags: {}, order: nid, mode: 0,
      properties: { "Node name for S&R": type },
    };
    if (inputs) n.inputs = inputs.map(([name, t]) => ({ name, type: t, link: null }));
    if (outputs) n.outputs = outputs.map(([name, t]) => ({ name, type: t, links: [], slot_index: 0 }));
    if (widgets) n.widgets_values = widgets;
    nodes.push(n);
    return n;
  };
  const wire = (from, fSlot, to, toName) => {
    const inIdx = (to.inputs || []).findIndex((i) => i.name === toName);
    const out = (from.outputs || [])[fSlot];
    if (inIdx < 0 || !out) return;
    const id = ++lid;
    links.push([id, from.id, fSlot, to.id, inIdx, out.type]);
    to.inputs[inIdx].link = id;
    out.links.push(id);
  };

  const ckpt = add("CheckpointLoaderSimple", [25, 250], [315, 98], [c.model], null,
    [["MODEL", "MODEL"], ["CLIP", "CLIP"], ["VAE", "VAE"]]);
  const posN = add("CLIPTextEncode", [400, 50], [400, 200], [c.positive],
    [["clip", "CLIP"]], [["CONDITIONING", "CONDITIONING"]]);
  const negN = add("CLIPTextEncode", [400, 300], [400, 200], [c.negative],
    [["clip", "CLIP"]], [["CONDITIONING", "CONDITIONING"]]);

  let latentSrc;
  if (task === "t2i") {
    latentSrc = add("EmptyLatentImage", [400, 550], [315, 106], [c.width, c.height, 1], null, [["LATENT", "LATENT"]]);
  } else {
    const load = add("LoadImage", [25, 400], [315, 314], [c.image, "image"], null, [["IMAGE", "IMAGE"]]);
    const enc = add("VAEEncode", [400, 550], [210, 46], null,
      [["pixels", "IMAGE"], ["vae", "VAE"]], [["LATENT", "LATENT"]]);
    wire(load, 0, enc, "pixels");
    wire(ckpt, 2, enc, "vae");
    latentSrc = enc;
  }

  const ks1 = add("KSampler", [875, 250], [315, 262],
    [c.seed, "randomize", c.steps, c.cfg, c.sampler, c.scheduler, task === "i2i" ? c.denoise : 1],
    [["model", "MODEL"], ["positive", "CONDITIONING"], ["negative", "CONDITIONING"], ["latent_image", "LATENT"]],
    [["LATENT", "LATENT"]]);

  wire(ckpt, 1, posN, "clip");
  wire(ckpt, 1, negN, "clip");
  wire(ckpt, 0, ks1, "model");
  wire(posN, 0, ks1, "positive");
  wire(negN, 0, ks1, "negative");
  wire(latentSrc, 0, ks1, "latent_image");

  let last = ks1;
  if (c.hires) {
    const up = add("LatentUpscaleBy", [1250, 250], [315, 82], ["bicubic", 1.5],
      [["samples", "LATENT"]], [["LATENT", "LATENT"]]);
    const ks2 = add("KSampler", [1625, 250], [315, 262],
      [c.seed, "randomize", c.p2Steps, c.cfg, c.sampler, c.scheduler, c.p2Denoise],
      [["model", "MODEL"], ["positive", "CONDITIONING"], ["negative", "CONDITIONING"], ["latent_image", "LATENT"]],
      [["LATENT", "LATENT"]]);
    wire(ckpt, 0, ks2, "model");
    wire(posN, 0, ks2, "positive");
    wire(negN, 0, ks2, "negative");
    wire(last, 0, up, "samples");
    wire(up, 0, ks2, "latent_image");
    last = ks2;
  }

  const decodeX = c.hires ? 2000 : 1250;
  const dec = add("VAEDecode", [decodeX, 250], [210, 46], null,
    [["samples", "LATENT"], ["vae", "VAE"]], [["IMAGE", "IMAGE"]]);
  const save = add("SaveImage", [decodeX + 250, 250], [315, 270], [c.prefix],
    [["images", "IMAGE"]], null);

  wire(last, 0, dec, "samples");
  wire(ckpt, 2, dec, "vae");
  wire(dec, 0, save, "images");

  return {
    last_node_id: nid,
    last_link_id: lid,
    nodes, links, groups: [], config: {},
    extra: { ds: { scale: 1, offset: [0, 0] } },
    version: 0.4,
  };
}

module.exports = { auditWorkflow, improveWorkflow, buildWorkflow, PRESETS, QUALITY_NEGATIVE, detectFamily };
