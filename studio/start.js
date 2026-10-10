"use strict";

// One double-click entry point.
//   1. start ComfyUI if it isn't already listening on 8188
//   2. start the studio server if it isn't already listening on 7860
//   3. open the browser
// Prints plain-language progress so a non-technical user can see what's happening.

const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const COMFY_BAT = "D:\\ComfyUI_windows_portable\\ComfyUI\\run_nvidia_gpu.bat";
const STUDIO_PORT = 7860;
const COMFY_PORT = 8188;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log("  " + m);

function portOpen(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 2500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

async function waitFor(port, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await sleep(2000);
  }
  log(`Timed out waiting for ${label}.`);
  return false;
}

function openBrowser(url) {
  const cmd = process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawn(cmd, args, { detached: true, stdio: "ignore" }).unref(); } catch (e) { log("Could not open a browser automatically: " + e.message); }
}

async function main() {
  console.log("");
  console.log("  AI Studio is starting up...");
  console.log("");

  // ---- ComfyUI ----
  if (await portOpen(COMFY_PORT)) {
    log("Image generator (ComfyUI) is already running.");
  } else if (!fs.existsSync(COMFY_BAT)) {
    log("WARNING: could not find ComfyUI at:");
    log("  " + COMFY_BAT);
    log("Image/video generation will not work until that is installed.");
  } else {
    log("Starting the image generator (ComfyUI)...");
    log("A black window will open - please leave it alone, it is normal.");
    try {
      spawn("cmd", ["/c", "start", "\"ComfyUI\"", "/min", "cmd", "/c", `"${COMFY_BAT}"`], {
        cwd: path.dirname(COMFY_BAT),
        detached: true,
        stdio: "ignore",
        shell: true,
      }).unref();
    } catch (e) {
      log("Could not start ComfyUI: " + e.message);
    }
    log("Waiting for it to be ready (this can take a minute the first time)...");
    const ok = await waitFor(COMFY_PORT, "ComfyUI", 240000);
    if (ok) log("Image generator is ready.");
  }

  // ---- studio server ----
  if (await portOpen(STUDIO_PORT)) {
    log("Studio is already running.");
  } else {
    log("Starting the studio...");
    const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const ok = await waitFor(STUDIO_PORT, "the studio", 45000);
    if (!ok) {
      console.log("");
      console.log("  Something went wrong starting the studio.");
      console.log("  Try running:  node studio/server.js");
      console.log("");
      process.exit(1);
    }
    log("Studio is ready.");
  }

  console.log("");
  log("Opening your browser...");
  openBrowser(`http://127.0.0.1:${STUDIO_PORT}`);
  console.log("");
  console.log("  Everything is running. Keep this window open.");
  console.log("  To stop everything later, just close this window.");
  console.log("");
}

main().catch((e) => {
  console.error("Failed to start:", e.message);
  process.exit(1);
});
