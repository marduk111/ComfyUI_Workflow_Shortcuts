"use strict";

// Song Stats — reads a WAV file and reports what it contains.
// Args: { "file": "D:\\...\\song.wav" }  (falls back to the studio test song)

const path = require("path");
const { readWav } = require("../../studio/plugins/wav.js");

const args = JSON.parse(process.argv[2] || "{}");
const file = args.file || "D:\\ComfyUI_windows_portable\\ComfyUI\\input\\test_song.wav";

try {
  const wav = readWav(file);
  const ch = wav.channels;
  let peak = 0, sumSq = 0;
  for (let c = 0; c < ch.length; c++) {
    for (let i = 0; i < ch[c].length; i++) {
      const v = Math.abs(ch[c][i]);
      if (v > peak) peak = v;
      sumSq += ch[c][i] * ch[c][i];
    }
  }
  const total = ch.length * wav.frames || 1;
  const rms = Math.sqrt(sumSq / total);
  const dbfs = rms > 0 ? +(20 * Math.log10(rms)).toFixed(2) : -Infinity;
  console.log(JSON.stringify({
    file: path.basename(file),
    seconds: +(wav.frames / wav.sampleRate).toFixed(2),
    sampleRate: wav.sampleRate,
    channels: ch.length,
    bitDepth: wav.bits,
    peak: +peak.toFixed(4),
    rms: +rms.toFixed(5),
    loudnessDbfs: dbfs,
  }));
} catch (e) {
  console.log(JSON.stringify({ error: "Could not read that file: " + e.message }));
  process.exitCode = 1;
}
