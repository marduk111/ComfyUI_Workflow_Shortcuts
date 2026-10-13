"use strict";

// ============================================================
// Central machine configuration.
//
// Every path the studio uses to talk to ComfyUI lives here so the
// project can run on any Windows machine, not just the one it was
// built on.
//
// Order of preference for each value:
//   1. environment variable  (COMFY_ROOT, COMFY_URL, COMFY_INPUT, ...)
//   2. auto-detected install
//   3. the original default
// ============================================================

const fs = require("fs");
const path = require("path");

function detectComfyRoot() {
  if (process.env.COMFY_ROOT) return process.env.COMFY_ROOT;
  const candidates = [
    "D:\\ComfyUI_windows_portable",
    "C:\\ComfyUI_windows_portable",
    "D:\\ComfyUI",
    "C:\\ComfyUI",
    path.resolve(__dirname, "..", "..", "ComfyUI_windows_portable"),
    path.resolve(__dirname, "..", "ComfyUI_windows_portable"),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(path.join(c, "ComfyUI"))) return c; } catch {}
  }
  return candidates[0];
}

const COMFY_ROOT = detectComfyRoot();

module.exports = {
  COMFY_ROOT,
  COMFY_URL: process.env.COMFY_URL || "http://127.0.0.1:8188",
  OLLAMA_URL: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
  INPUT_DIR: process.env.COMFY_INPUT || path.join(COMFY_ROOT, "ComfyUI", "input"),
  OUTPUT_DIR: process.env.COMFY_OUTPUT || path.join(COMFY_ROOT, "ComfyUI", "output"),
  MODELS_DIR: process.env.COMFY_MODELS || path.join(COMFY_ROOT, "ComfyUI", "models"),
  PY_EXE: process.env.COMFY_PY || path.join(COMFY_ROOT, "python_embeded", "python.exe"),
  COMFY_BAT: path.join(COMFY_ROOT, "ComfyUI", "run_nvidia_gpu.bat"),
  comfyInstalled() {
    try { return fs.existsSync(path.join(COMFY_ROOT, "ComfyUI")); } catch { return false; }
  },
};
