"use strict";

// Compile a plugin definition (JSON manifest + g.* graph code) into something
// that actually runs: an AudioWorklet module + a manifest the browser host
// page loads. Everything lands under public/plugins/ so the studio server
// serves it with no extra routes.
//
//   node studio/plugins/build.js <plugin.json> [demo=<audio.wav>]
//   node studio/plugins/build.js all
//
// Prints one JSON object.

const fs = require("fs");
const path = require("path");
const { compilePlugin } = require("./graph.js");

const ROOT = path.resolve(__dirname, "..", "..");
const PLUGINS_SRC = path.join(ROOT, "plugins");
const OUT_DIR = path.join(ROOT, "studio", "public", "plugins");

function listSources() {
  if (!fs.existsSync(PLUGINS_SRC)) return [];
  return fs.readdirSync(PLUGINS_SRC).filter((f) => f.endsWith(".json")).map((f) => path.join(PLUGINS_SRC, f));
}

function writeIndex(entries) {
  const idx = path.join(OUT_DIR, "index.json");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(idx, JSON.stringify({ generatedAt: new Date().toISOString(), plugins: entries }, null, 2));
  return idx;
}

function readIndex() {
  try { return JSON.parse(fs.readFileSync(path.join(OUT_DIR, "index.json"), "utf8")); } catch { return { plugins: [] }; }
}

function buildOne(file, opts = {}) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!raw.id) raw.id = path.basename(file, ".json").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const { manifest, workletSource } = compilePlugin(raw, { sampleRate: opts.sampleRate || 48000 });

  const dir = path.join(OUT_DIR, manifest.id);
  fs.mkdirSync(dir, { recursive: true });
  const workletPath = path.join(dir, manifest.processorName + ".js");
  const manifestPath = path.join(dir, "manifest.json");
  fs.writeFileSync(workletPath, workletSource);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // keep whatever else is already in the index, replace this id
  const idx = readIndex();
  const entry = {
    id: manifest.id, displayName: manifest.displayName, kind: manifest.kind,
    description: manifest.description, parameters: manifest.parameters.length,
    processorName: manifest.processorName, builtAt: manifest.builtAt,
    worklet: `/plugins/${manifest.id}/${manifest.processorName}.js`,
    manifestUrl: `/plugins/${manifest.id}/manifest.json`,
  };
  const rest = (idx.plugins || []).filter((p) => p.id !== manifest.id);
  writeIndex([...rest, entry].sort((a, b) => a.id.localeCompare(b.id)));

  return {
    id: manifest.id, displayName: manifest.displayName,
    nodes: manifest.nodeCount, params: manifest.parameters.length,
    processor: manifest.processorName,
    workletPath: path.relative(ROOT, workletPath),
    manifestPath: path.relative(ROOT, manifestPath),
    url: `http://127.0.0.1:7860/plugin.html?p=${manifest.id}`,
  };
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log(JSON.stringify({ error: "usage: node studio/plugins/build.js <plugin.json>|all [demo=<wav>]" }, null, 2));
    process.exitCode = 3;
    return;
  }
  const demoArg = args.find((a) => a.startsWith("demo="));
  const demoSrc = demoArg ? demoArg.slice(5) : null;
  const targets = args[0] === "all" ? listSources() : [path.resolve(args[0])];

  const built = [], errors = [];
  for (const f of targets) {
    try {
      if (!fs.existsSync(f)) throw new Error(`no such file: ${f}`);
      built.push(buildOne(f));
    } catch (e) {
      errors.push({ file: f, error: String(e.message || e) });
    }
  }

  let demo = null;
  if (demoSrc) {
    try {
      const dest = path.join(OUT_DIR, "demo.wav");
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.copyFileSync(demoSrc, dest);
      demo = { copied: path.relative(ROOT, dest), bytes: fs.statSync(dest).size };
    } catch (e) {
      errors.push({ file: demoSrc, error: "demo copy failed: " + e.message });
    }
  }

  const result = { built, errors, index: path.relative(ROOT, path.join(OUT_DIR, "index.json")) };
  if (demo) result.demo = demo;
  console.log(JSON.stringify(result, null, 2));
  if (errors.length && !built.length) process.exitCode = 3;
}

main();
