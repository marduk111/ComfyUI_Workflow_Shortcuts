"use strict";

// Minimal WAV I/O: read 16/24/32-bit PCM and 32-bit float, write 16-bit PCM.
const fs = require("fs");

function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.length < 44 || b.slice(0, 4).toString("ascii") !== "RIFF" || b.slice(8, 12).toString("ascii") !== "WAVE") {
    throw new Error(`${file} is not a RIFF/WAVE file`);
  }
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= b.length) {
    const id = b.slice(pos, pos + 4).toString("ascii");
    const size = b.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      fmt = {
        format: b.readUInt16LE(body),
        channels: b.readUInt16LE(body + 2),
        sampleRate: b.readUInt32LE(body + 4),
        bits: b.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = { offset: body, size: Math.min(size, b.length - body) };
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${file}: missing fmt or data chunk`);
  const { channels, sampleRate, bits, format } = fmt;
  const ch = [];
  for (let c = 0; c < channels; c++) ch.push(new Float32Array(0));
  const bytes = bits >> 3;
  const frames = Math.floor(data.size / (bytes * channels));
  for (let c = 0; c < channels; c++) ch[c] = new Float32Array(frames);

  if (format === 3 && bits === 32) {
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < channels; c++)
        ch[c][i] = b.readFloatLE(data.offset + (i * channels + c) * 4);
  } else if (format === 1 && bits === 16) {
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < channels; c++)
        ch[c][i] = b.readInt16LE(data.offset + (i * channels + c) * 2) / 32768;
  } else if (format === 1 && bits === 24) {
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < channels; c++) {
        const o = data.offset + (i * channels + c) * 3;
        let v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
        if (v & 0x800000) v |= ~0xffffff;
        ch[c][i] = v / 8388608;
      }
  } else if (format === 1 && bits === 32) {
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < channels; c++)
        ch[c][i] = b.readInt32LE(data.offset + (i * channels + c) * 4) / 2147483648;
  } else {
    throw new Error(`${file}: unsupported WAV format ${format}/${bits}-bit`);
  }
  return { channels: ch, sampleRate, frames, bits, format };
}

function writeWav16(file, chans, sampleRate) {
  const frames = chans[0].length, nch = chans.length;
  const dataBytes = frames * nch * 2;
  const b = Buffer.alloc(44 + dataBytes);
  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(36 + dataBytes, 4); b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii"); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(nch, 22); b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * nch * 2, 28); b.writeUInt16LE(nch * 2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii"); b.writeUInt32LE(dataBytes, 40);
  let o = 44;
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < nch; c++) {
      let v = chans[c][i];
      v = v > 1 ? 1 : v < -1 ? -1 : v;
      b.writeInt16LE(Math.round(v * 32767), o); o += 2;
    }
  fs.writeFileSync(file, b);
  return { file, frames, sampleRate, channels: nch };
}

module.exports = { readWav, writeWav16 };
