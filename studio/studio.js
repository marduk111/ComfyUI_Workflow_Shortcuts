#!/usr/bin/env node
"use strict";

// One front door to ComfyUI for the agent.
//
//   node studio/studio.js <command> [workflow.json] ['{"key":"value"}' | key=value ...]
//
// Examples:
//   node studio/studio.js status
//   node studio/studio.js list
//   node studio/studio.js describe SD15_Text2Img.json
//   node studio/studio.js run SD15_Text2Img.json positive="a cozy cabin" steps=12
//   node studio/studio.js wait
//   node studio/studio.js outputs limit=5
//
// Everything prints one JSON object to stdout, so the agent can read it back
// in a single bash call. No prompts, no files to edit by hand.

const { TOOLS } = require("./comfy_tools.js");

const USAGE = [
  "Usage: node studio/studio.js <command> [workflow.json] [key=value ...]",
  "",
  "Commands:",
  ...Object.entries(TOOLS).map(([name, t]) => `  ${name.padEnd(11)} ${t.description}${t.args ? `\n              ${t.args}` : ""}`),
  "",
  "Arguments are key=value pairs, or a JSON object in one argument.",
  "If the second argument ends in .json it is used as the workflow.",
].join("\n");

function parseArgs(argv) {
  const out = {};
  for (const raw of argv) {
    if (raw.trim().startsWith("{")) {
      try { Object.assign(out, JSON.parse(raw)); } catch (e) { out._jsonError = "Bad JSON: " + e.message; }
      continue;
    }
    const eq = raw.indexOf("=");
    if (eq > 0) {
      const key = raw.slice(0, eq);
      let val = raw.slice(eq + 1);
      if (val === "true") val = true;
      else if (val === "false") val = false;
      else if (val !== "" && !Number.isNaN(Number(val))) val = Number(val);
      out[key] = val;
      continue;
    }
    if (raw.endsWith(".json") && out.workflow == null) { out.workflow = raw; continue; }
    if (out._pos == null) out._pos = raw; else out._pos += " " + raw;
  }
  return out;
}

async function main() {
  const [, , command, ...rest] = process.argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    process.exit(command ? 0 : 1);
  }

  const tool = TOOLS[command];
  if (!tool) {
    console.error(`Unknown command: ${command}\n`);
    console.error(USAGE);
    process.exit(2);
  }

  const args = parseArgs(rest);
  // `upload <sourcePath> [newName]` takes bare positionals.
  if (command === "upload") {
    if (args.sourcePath == null && args._pos) {
      const [src, ...restPos] = args._pos.split(" ");
      args.sourcePath = src;
      if (restPos.length && args.newName == null) args.newName = restPos.join(" ");
    }
  }

  let result;
  try {
    result = await tool.run(args);
  } catch (e) {
    result = { error: String((e && e.message) || e) };
  }

  console.log(JSON.stringify(result, null, 2));
  // Exit by unwinding instead of process.exit(): forcing the exit while the
  // HTTP keep-alive socket is still closing trips a libuv assertion on Windows
  // and reports a bogus non-zero code to whoever called us.
  process.exitCode = result && result.error ? 3 : 0;
}

main().catch((e) => {
  console.log(JSON.stringify({ error: String((e && e.message) || e) }, null, 2));
  process.exitCode = 3;
});
