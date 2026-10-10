"use strict";

// ============================================================
// Connectors — saved recipes for calling outside services.
//
// Reverse engineering a website produces a recipe: this endpoint,
// this method, these headers, this body shape. A connector file
// keeps that recipe so the AI (or any app) can call the service
// directly next time — no browser, no clicking around.
//
// A connector is a JSON file in connectors/:
//   {
//     "id": "suno-create",
//     "name": "Suno — create a song",
//     "baseUrl": "https://studio-api.suno.com",
//     "requiresLogin": true,              // call through the browser session
//     "steps": [
//       { "method": "POST", "path": "/api/generate",
//         "headers": { "Content-Type": "application/json" },
//         "body": { "prompt": "{{prompt}}", "tags": "{{tags}}" } }
//     ],
//     "notes": "Captured 2026-10-10. Needs a logged-in Suno account."
//   }
//
// {{placeholders}} come from args at call time. When requiresLogin is
// true, calls go through the studio browser's cookies (web action=fetch)
// so the human's existing login is reused — no password handling here.
// ============================================================

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "connectors");

function validId(id) {
  return /^[a-z0-9][a-z0-9-]{1,48}$/.test(String(id || ""));
}

function fileFor(id) {
  return path.join(DIR, id + ".json");
}

function list() {
  if (!fs.existsSync(DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
      out.push({
        id: c.id || f.replace(/\.json$/, ""),
        name: c.name || f,
        baseUrl: c.baseUrl || null,
        requiresLogin: !!c.requiresLogin,
        steps: (c.steps || []).length,
        notes: c.notes || "",
      });
    } catch {}
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function get(id) {
  if (!validId(id)) return null;
  try { return JSON.parse(fs.readFileSync(fileFor(id), "utf8")); } catch { return null; }
}

function save(c) {
  const id = validId(c.id) ? c.id : String(c.id || c.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  if (!validId(id)) return { error: "Need an id with letters, numbers and dashes." };
  if (!Array.isArray(c.steps) || !c.steps.length) return { error: "steps must be a non-empty list of {method, path, headers?, body?}." };
  fs.mkdirSync(DIR, { recursive: true });
  const out = { id, name: c.name || id, baseUrl: c.baseUrl || "", requiresLogin: !!c.requiresLogin, steps: c.steps, notes: c.notes || "", savedAt: new Date().toISOString() };
  fs.writeFileSync(fileFor(id), JSON.stringify(out, null, 2));
  return { saved: id, path: path.relative(ROOT, fileFor(id)) };
}

function remove(id) {
  if (!validId(id)) return { error: "bad id" };
  const f = fileFor(id);
  if (!fs.existsSync(f)) return { error: `No connector named "${id}"` };
  fs.rmSync(f);
  return { removed: id };
}

// Replace {{placeholders}} in strings, recursively, from a flat args object.
function fill(value, args) {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => {
      if (args[key] == null) return "";
      return String(args[key]);
    });
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, args));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = fill(v, args);
    return out;
  }
  return value;
}

// Find missing placeholders so the caller can be told exactly what to pass.
function missing(step, args) {
  const need = new Set();
  const walk = (v) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) if (args[m[1]] == null) need.add(m[1]);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(step);
  return [...need];
}

module.exports = { list, get, save, remove, fill, missing, validId, DIR };
