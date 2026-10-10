"use strict";

// Browser host for compiled plugins. Loads /plugins/index.json, pulls a
// manifest + its generated AudioWorklet, and streams audio through it.
// The worklet is the exact same engine the Node verifier tested.

const $ = (id) => document.getElementById(id);
const sel = $("sel"), statusEl = $("status"), paramsEl = $("params"), descEl = $("desc"), meterEl = $("meter");

let index = null, manifest = null, entry = null;
let ctx = null, workletNode = null, srcNode = null, analyser = null;
let buffer = null, workletReady = false, meterTimer = null;

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = kind || "";
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

async function loadIndex() {
  index = await fetchJson("/plugins/index.json");
  const list = index.plugins || [];
  sel.innerHTML = "";
  if (!list.length) {
    sel.innerHTML = "<option>(none built yet)</option>";
    setStatus("No plugins built. Run: node studio/plugins/build.js all", "busy");
    return;
  }
  for (const p of list) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.displayName || p.id;
    sel.appendChild(o);
  }
  const want = new URLSearchParams(location.search).get("p");
  sel.value = want && list.some((p) => p.id === want) ? want : list[0].id;
  await pick(sel.value);
}

async function ensureContext(rate) {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  try { ctx = new AC({ sampleRate: rate }); }
  catch { ctx = new AC(); }
  if (ctx.sampleRate !== rate) {
    setStatus(`Note: audio runs at ${ctx.sampleRate} Hz, plugin was built for ${rate} Hz.`, "busy");
  }
  return ctx;
}

async function pick(id) {
  stop();
  entry = (index.plugins || []).find((p) => p.id === id);
  if (!entry) return;
  workletReady = false;
  buffer = null;
  descEl.textContent = entry.description || "";
  paramsEl.innerHTML = "";
  $("play").disabled = true; $("stop").disabled = true; $("export").disabled = true; $("demo").disabled = true;
  setStatus("Loading manifest…", "busy");
  try {
    manifest = await fetchJson(entry.manifestUrl);
    const c = await ensureContext(manifest.sampleRate || 48000);
    await c.audioWorklet.addModule(entry.worklet);
    workletNode = new AudioWorkletNode(c, manifest.processorName, {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    });
    analyser = c.createAnalyser();
    analyser.fftSize = 256;
    workletNode.connect(analyser).connect(c.destination);
    buildParams(manifest);
    workletReady = true;
    $("demo").disabled = false;
    setStatus(`${manifest.displayName} ready — ${manifest.nodeCount} DSP nodes, ${manifest.parameters.length} controls.`, "ok");
    const p = new URLSearchParams(location.search);
    if (p.get("p") !== id) { p.set("p", id); history.replaceState(null, "", `?${p}`); }
  } catch (e) {
    setStatus("Failed to load: " + e.message, "err");
  }
}

function buildParams(m) {
  paramsEl.innerHTML = "";
  for (const p of m.parameters) {
    const wrap = document.createElement("div");
    wrap.className = "param";
    const top = document.createElement("div");
    top.className = "top";
    const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = p.label + (p.unit ? ` (${p.unit})` : "");
    const val = document.createElement("span"); val.className = "val";
    top.append(nm, val);
    const input = document.createElement("input");
    input.type = "range";
    input.min = p.min; input.max = p.max;
    input.step = (p.max - p.min) / 200;
    input.value = p.default;
    const fmt = (v) => (p.unit === "percent" ? `${Math.round(v * 100)}%` : Number(v).toFixed(2));
    val.textContent = fmt(p.default);
    input.addEventListener("input", () => {
      const v = Number(input.value);
      val.textContent = fmt(v);
      const ap = workletNode && workletNode.parameters.get(p.audioName);
      if (ap) ap.value = v;
    });
    wrap.append(top, input);
    paramsEl.appendChild(wrap);
  }
}

function startMeter() {
  if (!analyser) return;
  const data = new Uint8Array(analyser.frequencyBinCount);
  clearInterval(meterTimer);
  meterTimer = setInterval(() => {
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) { const v = Math.abs(data[i] - 128) / 128; if (v > peak) peak = v; }
    meterEl.style.width = `${Math.min(100, peak * 100)}%`;
  }, 50);
}
function stopMeter() { clearInterval(meterTimer); meterEl.style.width = "0%"; }

async function ensureBuffer() {
  if (buffer) return buffer;
  const c = await ensureContext(manifest.sampleRate || 48000);
  setStatus("Loading demo song…", "busy");
  const r = await fetch("/plugins/demo.wav");
  if (!r.ok) throw new Error("demo.wav missing — run test_render.js first");
  buffer = await c.decodeAudioData(await r.arrayBuffer());
  $("play").disabled = false; $("export").disabled = false;
  setStatus(`Demo song loaded (${buffer.duration.toFixed(1)} s). Press Play.`, "ok");
  return buffer;
}

function stop() {
  try { srcNode && srcNode.stop(); } catch {}
  srcNode = null;
  stopMeter();
  $("play").disabled = !buffer; $("stop").disabled = true;
}

async function play() {
  try {
    const c = await ensureContext(manifest.sampleRate || 48000);
    await c.resume();
    const buf = await ensureBuffer();
    stop();
    srcNode = c.createBufferSource();
    srcNode.buffer = buf;
    srcNode.loop = true;
    srcNode.connect(workletNode);
    srcNode.start();
    $("stop").disabled = false;
    $("play").disabled = true;
    startMeter();
    setStatus("Playing (looped). Move the sliders — changes are live.", "ok");
  } catch (e) {
    setStatus("Play failed: " + e.message, "err");
  }
}

function encodeWav16(chans, sampleRate) {
  const frames = chans[0].length, nch = chans.length;
  const dataBytes = frames * nch * 2;
  const b = new ArrayBuffer(44 + dataBytes), dv = new DataView(b);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); dv.setUint32(4, 36 + dataBytes, true); ws(8, "WAVE");
  ws(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, nch, true); dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * nch * 2, true); dv.setUint16(32, nch * 2, true); dv.setUint16(34, 16, true);
  ws(36, "data"); dv.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < nch; c++) {
      let v = chans[c][i]; v = v > 1 ? 1 : v < -1 ? -1 : v;
      dv.setInt16(o, Math.round(v * 32767), true); o += 2;
    }
  return b;
}

async function exportWav() {
  try {
    stop();
    const buf = await ensureBuffer();
    setStatus("Rendering offline…", "busy");
    const rate = manifest.sampleRate || 48000;
    const oc = new OfflineAudioContext(2, buf.length, rate);
    await oc.audioWorklet.addModule(entry.worklet);
    const node = new AudioWorkletNode(oc, manifest.processorName, {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    });
    for (const p of manifest.parameters) {
      const ap = node.parameters.get(p.audioName);
      const input = [...paramsEl.querySelectorAll(".param")][manifest.parameters.indexOf(p)]?.querySelector("input");
      if (ap && input) ap.value = Number(input.value);
    }
    const src = oc.createBufferSource();
    src.buffer = buf;
    src.connect(node).connect(oc.destination);
    src.start();
    const rendered = await oc.startRendering();
    const wav = encodeWav16([rendered.getChannelData(0), rendered.getChannelData(1)], rate);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
    a.download = `${manifest.id}_processed.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    setStatus("Exported. Check your downloads folder.", "ok");
  } catch (e) {
    setStatus("Export failed: " + e.message, "err");
  }
}

sel.addEventListener("change", () => pick(sel.value));
$("play").addEventListener("click", play);
$("stop").addEventListener("click", () => { stop(); setStatus("Stopped.", "ok"); });
$("export").addEventListener("click", exportWav);
$("demo").addEventListener("click", () => ensureBuffer().catch((e) => setStatus(e.message, "err")));
$("file").parentElement.addEventListener("click", () => $("file").click());
$("file").addEventListener("change", async (ev) => {
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  try {
    const c = await ensureContext(manifest.sampleRate || 48000);
    setStatus(`Decoding ${f.name}…`, "busy");
    buffer = await c.decodeAudioData(await f.arrayBuffer());
    $("play").disabled = false; $("export").disabled = false;
    setStatus(`Loaded ${f.name} (${buffer.duration.toFixed(1)} s). Press Play.`, "ok");
  } catch (e) {
    setStatus("Could not decode that file: " + e.message, "err");
  }
  ev.target.value = "";
});

loadIndex().catch((e) => setStatus("Could not load plugin list: " + e.message, "err"));
