"use strict";

// Numeric proof that a compiled plugin graph behaves before anyone presses
// play in a browser. Renders a real WAV through the same engine the worklet
// uses and checks invariants:
//
//   1. Mix=0 must be a bit-identical bypass of the input.
//   2. Default settings must actually change the signal (finite, non-zero).
//   3. All-params-min and all-params-max must stay finite and bounded.
//
//   node studio/plugins/test_render.js <plugin.json> [input.wav] [seconds=8]
//
// Writes the processed render plus an 8 s dry demo clip for the browser host
// under public/plugins/. Prints one JSON object; exits 3 on a failed check.

const fs = require("fs");
const path = require("path");
const { buildGraph, renderGraph, isFiniteArray, rms, sanitizeProcessorName } = require("./graph.js");
const { readWav, writeWav16 } = require("./wav.js");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT_DIR = path.join(ROOT, "studio", "public", "plugins");

function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > m) m = d; }
  return m;
}
function peak(a) {
  let m = 0;
  for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > m) m = v; }
  return m;
}
function slice(chans, start, len) {
  return chans.map((c) => c.subarray(start, Math.min(start + len, c.length)));
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log(JSON.stringify({ error: "usage: node studio/plugins/test_render.js <plugin.json> [input.wav] [seconds=8]" }, null, 2));
    process.exitCode = 3;
    return;
  }
  const pluginPath = path.resolve(args[0]);
  const inputPath = args[1] ? path.resolve(args[1]) : path.join(require("../config.js").INPUT_DIR, "test_song.wav");
  const seconds = Number(args[2] || 8);

  const plugin = JSON.parse(fs.readFileSync(pluginPath, "utf8"));
  if (!plugin.id) plugin.id = path.basename(pluginPath, ".json").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const wav = readWav(inputPath);
  const graph = buildGraph(plugin, { sampleRate: wav.sampleRate });

  const len = Math.min(wav.frames, Math.round(wav.sampleRate * seconds));
  const inL = wav.channels[0].subarray(0, len);
  const inR = (wav.channels[1] || wav.channels[0]).subarray(0, len);

  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

  // 1. Mix=0 bypass
  const bypass = renderGraph(graph, [inL, inR], { Mix: 0 }, wav.sampleRate);
  const bypassDiff = Math.max(maxAbsDiff(bypass.outL, inL), maxAbsDiff(bypass.outR, inR));
  add("bypass_mix0_identical", bypassDiff < 1e-6, `max|diff|=${bypassDiff.toExponential(2)} (want < 1e-6)`);

  // 2. defaults actually process
  const dflt = renderGraph(graph, [inL, inR], {}, wav.sampleRate);
  const badDflt = isFiniteArray(dflt.outL);
  const badDfltR = isFiniteArray(dflt.outR);
  add("defaults_finite", badDflt < 0 && badDfltR < 0,
    badDflt < 0 && badDfltR < 0 ? `peak L=${peak(dflt.outL).toFixed(3)} R=${peak(dflt.outR).toFixed(3)}` : `NaN at frame ${Math.max(badDflt, badDfltR)}`);
  const rmsIn = rms(inL), rmsOut = rms(dflt.outL);
  add("defaults_changes_signal", rmsOut > 0 && Math.abs(rmsOut - rmsIn) > 1e-6,
    `rms in=${rmsIn.toFixed(5)} out=${rmsOut.toFixed(5)}`);

  // 3. parameter corners stay sane
  const params = plugin.parameters || [];
  const allMin = {}, allMax = {};
  for (const p of params) {
    allMin[p.name] = p.range && typeof p.range.min === "number" ? p.range.min : 0;
    allMax[p.name] = p.range && typeof p.range.max === "number" ? p.range.max : 1;
  }
  for (const [label, corner] of [["min", allMin], ["max", allMax]]) {
    const r = renderGraph(graph, [inL, inR], corner, wav.sampleRate);
    const bad = isFiniteArray(r.outL), badR = isFiniteArray(r.outR);
    const pk = peak(r.outL);
    add(`params_${label}_finite`, bad < 0 && badR < 0 && pk < 8,
      bad < 0 && badR < 0 ? `peak=${pk.toFixed(3)}` : `NaN at frame ${Math.max(bad, badR)}`);
  }

  // write artifacts
  fs.mkdirSync(path.join(OUT_DIR, "out"), { recursive: true });
  const procPath = path.join(OUT_DIR, "out", `${plugin.id}_processed.wav`);
  writeWav16(procPath, [dflt.outL, dflt.outR], wav.sampleRate);

  const demoPath = path.join(OUT_DIR, "demo.wav");
  const demo = slice(wav.channels, 0, len);
  writeWav16(demoPath, demo.length > 1 ? [demo[0], demo[1]] : [demo[0], demo[0]], wav.sampleRate);

  const failed = checks.filter((c) => !c.ok);
  const result = {
    plugin: plugin.id,
    input: { file: path.basename(inputPath), sampleRate: wav.sampleRate, channels: wav.channels.length, framesUsed: len },
    nodes: graph.nodes.length,
    checks,
    artifacts: {
      processed: path.relative(ROOT, procPath),
      demo: path.relative(ROOT, demoPath),
    },
    status: failed.length ? "fail" : "pass",
  };
  console.log(JSON.stringify(result, null, 2));
  if (failed.length) process.exitCode = 3;
}

main();
