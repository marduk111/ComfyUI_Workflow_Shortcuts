"use strict";

// Plugin graph engine.
//
// A "plugin" is a JSON manifest (ports, parameters, UI) plus source.code that
// declares `function build(g, config)` over a small DSP graph DSL:
//
//   g.input('audioInL') / g.input('Instrument Focus')   audio channel or parameter
//   g.constant(1) g.zero()
//   g.add/sub/mul/div(a,b)  g.madd(a,b,c)  g.scale(x,mul,add)
//   g.max(a,b) g.abs(a) g.clamp(x,min,max) g.tanh(x) g.lerp(t,a,b)
//   g.modLog2Hz(base, semitones, minHz, maxHz)
//   g.biquad({input, cutoff, resonance, mode}, tag)
//   g.asymmetricOnePole({target, attackCoef, releaseCoef}, tag)
//   g.output('audioOutL', node)
//
// buildGraph() records that into a flat IR. The SAME evaluator source then
// runs offline in Node (for verification) and inside an AudioWorklet (in the
// browser), so what is tested is what plays.

const OPS = {
  const: 0, param: 1, audioL: 2, audioR: 3,
  add: 4, sub: 5, mul: 6, div: 7, madd: 8, scale: 9,
  max: 10, abs: 11, clamp: 12, tanh: 13, lerp: 14, modlog: 15,
  biquad: 16, onepole: 17,
};

const BQ_MODES = { lowpass: 0, highpass: 1, bandpass: 2, notch: 3 };

// One evaluator, serialised as source so the worklet and Node share it exactly.
const EVAL_SRC = `function makeEngine(T, sr){
  const OP=T.OP,A=T.A,B=T.B,C=T.C,D=T.D,F=T.F,G=T.G,PM=T.PARAM;
  const SR=(typeof sr==='number'&&sr>0)?sr:T.sampleRate;
  const n=T.n, nState=T.nState, nParams=T.nParams;
  const S=new Float32Array(n), ST=new Float32Array(nState), PV=new Float32Array(nParams);
  const Z=new Float32Array(1);
  function reset(){ ST.fill(0); S.fill(0); }
  function frame(inL,inR,o){
    for(let i=0;i<n;i++){
      const op=OP[i],a=A[i],b=B[i],c=C[i],d=D[i],f=F[i],gg=G[i];
      let v=0;
      switch(op){
        case 0: v=f; break;
        case 1: v=PV[PM[i]]; break;
        case 2: v=inL; break;
        case 3: v=inR; break;
        case 4: v=S[a]+S[b]; break;
        case 5: v=S[a]-S[b]; break;
        case 6: v=S[a]*S[b]; break;
        case 7: { const den=S[b]; v=den===0?0:S[a]/den; break; }
        case 8: v=S[a]*S[b]+f; break;
        case 9: v=S[a]*f+gg; break;
        case 10: v=S[a]>S[b]?S[a]:S[b]; break;
        case 11: v=S[a]<0?-S[a]:S[a]; break;
        case 12: v=S[a]; if(v<f)v=f; else if(v>gg)v=gg; break;
        case 13: v=Math.tanh(S[a]); break;
        case 14: { const t=S[a],x=S[b],y=S[c]; v=x+(y-x)*t; break; }
        case 15: { v=S[a]*Math.pow(2,S[b]); if(v<f)v=f; else if(v>gg)v=gg; break; }
        case 16: {
          const x=S[a];
          let fc=S[b]; const q=S[c]<0.001?0.001:S[c];
          const nyq=SR*0.49;
          if(fc<10)fc=10; else if(fc>nyq)fc=nyq;
          const w0=6.283185307179586*fc/SR;
          const cw=Math.cos(w0), sw=Math.sin(w0), al=sw/(2*q);
          let b0,b1,b2,a0,a1,a2;
          if(f===0){ b0=(1-cw)/2; b1=1-cw; b2=(1-cw)/2; a0=1+al; a1=-2*cw; a2=1-al; }
          else if(f===1){ b0=(1+cw)/2; b1=-(1+cw); b2=(1+cw)/2; a0=1+al; a1=-2*cw; a2=1-al; }
          else if(f===3){ b0=1; b1=-2*cw; b2=1; a0=1+al; a1=-2*cw; a2=1-al; }
          else { b0=al; b1=0; b2=-al; a0=1+al; a1=-2*cw; a2=1-al; }
          const ib=1/a0;
          const x1=ST[d],x2=ST[d+1],y1=ST[d+2],y2=ST[d+3];
          const y=(b0*x+b1*x1+b2*x2-a1*y1-a2*y2)*ib;
          ST[d]=x; ST[d+1]=x1; ST[d+2]=y; ST[d+3]=y1;
          v=y; break;
        }
        case 17: {
          const x=S[a]; let atk=S[b]; let rel=S[c];
          if(atk<0)atk=0; else if(atk>1)atk=1;
          if(rel<0)rel=0; else if(rel>1)rel=1;
          const prev=ST[d];
          const coef=x>prev?atk:rel;
          const y=prev+coef*(x-prev);
          ST[d]=y; v=y; break;
        }
        default: v=0;
      }
      S[i]=v;
    }
    o[0]=S[T.out0];
    o[1]=S[T.out1];
  }
  return { reset, frame, PV, ST, S };
}`;

const makeEngineFactory = new Function("return (" + EVAL_SRC + ")")();

function nref(x) {
  if (x && typeof x === "object" && typeof x.__n === "number") return x.__n;
  return -1;
}
function num(x, fallback) {
  return typeof x === "number" && Number.isFinite(x) ? x : fallback;
}

function buildGraph(plugin, opts = {}) {
  const sampleRate = num(opts.sampleRate, 48000);
  if (!plugin || typeof plugin.source !== "object" || typeof plugin.source.code !== "string") {
    throw new Error("plugin has no source.code");
  }
  const paramNames = (plugin.parameters || []).map((p) => String(p.name));
  const paramIndex = new Map(paramNames.map((n, i) => [n, i]));

  const nodes = [];
  const outputs = {};
  let audioSeen = 0;

  function push(op, a, b, c, d, f, g, extra) {
    const id = nodes.length;
    nodes.push({ op, a: a | 0, b: b | 0, c: c | 0, d: d | 0, f: f, g: g, extra: extra || null });
    return { __n: id };
  }
  function ref(x, what) {
    const id = nref(x);
    if (id < 0) throw new Error(`${what}: expected a graph node, got ${JSON.stringify(x)}`);
    return id;
  }
  function lit(x, what, dflt) {
    if (typeof x === "number" && Number.isFinite(x)) return x;
    if (x === undefined && dflt !== undefined) return dflt;
    throw new Error(`${what}: expected a number literal, got ${JSON.stringify(x)}`);
  }

  const OPSm = OPS;
  const g = {
    input(name) {
      const key = String(name);
      if (key === "audioInL" || key === "audioIn") { audioSeen |= 1; return push(OPSm.audioL); }
      if (key === "audioInR") { audioSeen |= 2; return push(OPSm.audioR); }
      if (paramIndex.has(key)) return push(OPSm.param, -1, -1, -1, -1, NaN, NaN, { param: paramIndex.get(key) });
      throw new Error(`g.input("${key}"): not an audio input or a declared parameter. Known parameters: ${paramNames.join(", ")}`);
    },
    output(name, node) {
      const key = String(name);
      if (outputs[key] !== undefined) throw new Error(`g.output("${key}"): already written`);
      outputs[key] = ref(node, "g.output");
    },
    constant(v) { return push(OPSm.const, -1, -1, -1, -1, lit(v, "g.constant")); },
    zero() { return push(OPSm.const, -1, -1, -1, -1, 0); },
    add(a, b) { return push(OPSm.add, ref(a, "g.add"), ref(b, "g.add")); },
    sub(a, b) { return push(OPSm.sub, ref(a, "g.sub"), ref(b, "g.sub")); },
    mul(a, b) { return push(OPSm.mul, ref(a, "g.mul"), ref(b, "g.mul")); },
    div(a, b) { return push(OPSm.div, ref(a, "g.div"), ref(b, "g.div")); },
    madd(a, b, base) { return push(OPSm.madd, ref(a, "g.madd"), ref(b, "g.madd"), -1, -1, lit(base, "g.madd base")); },
    scale(x, mul, add) { return push(OPSm.scale, ref(x, "g.scale"), -1, -1, -1, lit(mul, "g.scale mul"), lit(add, "g.scale add", 0)); },
    max(a, b) { return push(OPSm.max, ref(a, "g.max"), ref(b, "g.max")); },
    abs(a) { return push(OPSm.abs, ref(a, "g.abs")); },
    clamp(x, min, max) { return push(OPSm.clamp, ref(x, "g.clamp"), -1, -1, -1, lit(min, "g.clamp min"), lit(max, "g.clamp max")); },
    tanh(x) { return push(OPSm.tanh, ref(x, "g.tanh")); },
    lerp(t, a, b) { return push(OPSm.lerp, ref(t, "g.lerp t"), ref(a, "g.lerp a"), ref(b, "g.lerp b")); },
    modLog2Hz(base, mod, minHz, maxHz) {
      return push(OPSm.modlog, ref(base, "g.modLog2Hz base"), ref(mod, "g.modLog2Hz mod"), -1, -1,
        lit(minHz, "g.modLog2Hz minHz"), lit(maxHz, "g.modLog2Hz maxHz"));
    },
    biquad(o, tag) {
      const mode = BQ_MODES[String(o && o.mode || "lowpass")];
      if (mode === undefined) throw new Error(`g.biquad: unknown mode "${o.mode}" (use ${Object.keys(BQ_MODES).join("/")})`);
      return push(OPSm.biquad, ref(o.input, `g.biquad(${tag}) input`),
        ref(o.cutoff, `g.biquad(${tag}) cutoff`), ref(o.resonance == null ? 0.707 : o.resonance, `g.biquad(${tag}) resonance`),
        -1, mode, 0, { tag: String(tag || ""), state: true });
    },
    asymmetricOnePole(o, tag) {
      return push(OPSm.onepole, ref(o.target, `g.asymmetricOnePole(${tag}) target`),
        ref(o.attackCoef, `g.asymmetricOnePole(${tag}) attackCoef`),
        ref(o.releaseCoef, `g.asymmetricOnePole(${tag}) releaseCoef`),
        -1, NaN, NaN, { tag: String(tag || ""), state: true });
    },
  };

  const build = new Function(plugin.source.code + "\nreturn build;")();
  if (typeof build !== "function") throw new Error("source.code must define function build(g, config)");
  build(g, { sampleRate, pluginId: plugin.id, displayName: plugin.displayName });

  const outNames = Object.keys(outputs);
  if (!outNames.length) throw new Error("plugin wrote no g.output(...) — nothing would come out");

  // ---- flatten to typed tables ----
  const n = nodes.length;
  const OP = new Int32Array(n), A = new Int32Array(n), B = new Int32Array(n),
    C = new Int32Array(n), D = new Int32Array(n), PARAM = new Int32Array(n);
  const F = new Float64Array(n), G = new Float64Array(n);
  let stateOffset = 0;
  const stateNodes = [];
  for (let i = 0; i < n; i++) {
    const nd = nodes[i];
    OP[i] = nd.op; A[i] = nd.a; B[i] = nd.b; C[i] = nd.c; D[i] = nd.d;
    PARAM[i] = nd.extra && nd.extra.param !== undefined ? nd.extra.param : -1;
    F[i] = Number.isFinite(nd.f) ? nd.f : 0;
    G[i] = Number.isFinite(nd.g) ? nd.g : 0;
    if (nd.extra && nd.extra.state) {
      const size = nd.op === OPS.biquad ? 4 : 1;
      D[i] = stateOffset;
      stateNodes.push({ id: i, offset: stateOffset, size, tag: nd.extra.tag, op: nd.op });
      stateOffset += size;
    }
  }

  const pick = (names) => {
    for (const nm of names) if (outputs[nm] !== undefined) return outputs[nm];
    return undefined;
  };
  const out0 = pick(["audioOutL", "audioOut"]) ?? pick(outNames);
  const out1 = pick(["audioOutR", "audioOut"]) ?? out0;

  const table = {
    n, nState: stateOffset, nParams: paramNames.length, sampleRate,
    OP: Array.from(OP), A: Array.from(A), B: Array.from(B), C: Array.from(C), D: Array.from(D),
    PARAM: Array.from(PARAM), F: Array.from(F), G: Array.from(G),
    out0, out1,
  };

  return { plugin, sampleRate, nodes, outputs, paramNames, audioSeen, stateNodes, table, out0, out1 };
}

// ---------------- offline render (Node verification) ----------------

function renderGraph(graph, chans, params = {}, sampleRate = graph.sampleRate) {
  if (sampleRate !== graph.sampleRate) throw new Error(`graph was built for ${graph.sampleRate} Hz, render asked for ${sampleRate} Hz`);
  const T = graph.table;
  const engine = makeEngineFactory(T, sampleRate);
  engine.reset();
  const PV = engine.PV;
  for (let i = 0; i < graph.paramNames.length; i++) {
    const nm = graph.paramNames[i];
    const p = (graph.plugin.parameters || [])[i] || {};
    const v = params[nm];
    PV[i] = typeof v === "number" && Number.isFinite(v) ? v : (typeof p.default === "number" ? p.default : 0);
  }
  const inL = chans[0], inR = chans[1] || chans[0];
  const frames = inL.length;
  const o = new Float64Array(2);
  const outL = new Float32Array(frames), outR = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    engine.frame(inL[i], inR[i], o);
    outL[i] = o[0]; outR[i] = o[1];
  }
  return { outL, outR };
}

function isFiniteArray(a) {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return i;
  return -1;
}
function rms(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, a.length));
}

// ---------------- worklet emitter ----------------

function sanitizeProcessorName(id) {
  return "plugin_" + String(id || "unnamed").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
}
function paramAudioName(name) {
  return "p_" + String(name).replace(/[^A-Za-z0-9]+/g, "_");
}

function emitWorklet(graph) {
  const plugin = graph.plugin;
  const descriptors = (plugin.parameters || []).map((p) => ({
    name: paramAudioName(p.name),
    defaultValue: typeof p.default === "number" ? p.default : 0,
    minValue: p.range && typeof p.range.min === "number" ? p.range.min : 0,
    maxValue: p.range && typeof p.range.max === "number" ? p.range.max : 1,
    automationRate: "k-rate",
  }));
  const processorName = sanitizeProcessorName(plugin.id);
  const tableJson = JSON.stringify(graph.table);
  const descJson = JSON.stringify(descriptors);
  const namesJson = JSON.stringify(graph.paramNames.map(paramAudioName));

  return `// Generated by studio/plugins/graph.js — do not edit.
// ${plugin.displayName || plugin.id}
const T = ${tableJson};
const PD = ${descJson};
const PN = ${namesJson};
${EVAL_SRC}

class PluginProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() { return PD; }
  constructor() {
    super();
    this.E = makeEngine(T, sampleRate);
    this.E.reset();
    this.zero = new Float32Array(128);
  }
  process(inputs, outputs, params) {
    const out = outputs[0];
    if (!out || !out.length) return true;
    const o0 = out[0], o1 = out[1] || out[0];
    const in0 = inputs[0] || [];
    const inL = in0[0] || this.zero;
    const inR = in0[1] || inL;
    const PV = this.E.PV;
    for (let i = 0; i < PN.length; i++) {
      const a = params[PN[i]];
      PV[i] = a && a.length ? a[0] : PD[i].defaultValue;
    }
    const buf = [0, 0];
    for (let f = 0; f < o0.length; f++) {
      this.E.frame(f < inL.length ? inL[f] : 0, f < inR.length ? inR[f] : 0, buf);
      o0[f] = buf[0];
      o1[f] = buf[1];
    }
    return true;
  }
}
registerProcessor(${JSON.stringify(processorName)}, PluginProcessor);
`;
}

// ---------------- full compile ----------------

function compilePlugin(plugin, opts = {}) {
  const graph = buildGraph(plugin, opts);
  const workletSource = emitWorklet(graph);
  const manifest = {
    id: plugin.id,
    kind: plugin.kind || "effect",
    displayName: plugin.displayName || plugin.id,
    description: plugin.description || "",
    processorName: sanitizeProcessorName(plugin.id),
    sampleRate: graph.sampleRate,
    parameters: (plugin.parameters || []).map((p) => ({
      name: p.name,
      audioName: paramAudioName(p.name),
      label: p.label || p.name,
      default: typeof p.default === "number" ? p.default : 0,
      min: p.range && typeof p.range.min === "number" ? p.range.min : 0,
      max: p.range && typeof p.range.max === "number" ? p.range.max : 1,
      unit: p.unit || "",
      scale: p.scale || "linear",
    })),
    outputs: Object.keys(graph.outputs),
    nodeCount: graph.nodes.length,
    stateFloats: graph.table.nState,
    ui: plugin.ui || null,
    builtAt: new Date().toISOString(),
  };
  return { graph, manifest, workletSource };
}

module.exports = { buildGraph, renderGraph, emitWorklet, compilePlugin, makeEngineFactory, EVAL_SRC, OPS, BQ_MODES, isFiniteArray, rms, sanitizeProcessorName, paramAudioName };
