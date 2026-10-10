"use strict";

// MCP (Model Context Protocol) stdio server front door for the same operations
// studio/studio.js exposes as a CLI. Kept because MCP tools DO reach the model
// under `opencode run`; opencode 1.18.29 just doesn't forward them in `serve`
// mode, which is why the GUI's agent uses the CLI instead.

const { TOOLS } = require("./comfy_tools.js");

// MCP tool name -> (shared tool, how to map arguments)
const MCP_TOOLS = [
  { name: "comfyui_status", tool: "status", args: [] },
  { name: "comfyui_list_workflows", tool: "list", args: [] },
  { name: "comfyui_describe_workflow", tool: "describe", args: ["workflow"], required: ["workflow"] },
  { name: "comfyui_set_prompt", tool: "set_prompt", args: ["workflow", "positive", "negative", "promptNodeId"], required: ["workflow", "positive"] },
  { name: "comfyui_set_image", tool: "set_image", args: ["workflow", "filename", "nodeId"], required: ["workflow", "filename"] },
  { name: "comfyui_run_workflow", tool: "run", args: ["workflow", "positive", "negative", "image", "seed", "steps", "width", "height", "promptNodeId"], required: ["workflow"] },
  { name: "comfyui_queue_status", tool: "queue", args: [] },
  { name: "comfyui_get_outputs", tool: "outputs", args: ["limit"] },
  { name: "comfyui_list_models", tool: "models", args: [] },
  { name: "comfyui_upload_reference", tool: "upload", args: ["sourcePath", "newName"], required: ["sourcePath"] },
];

const SCHEMAS = {
  workflow: { type: "string", description: "Workflow filename, e.g. 'SD15_Text2Img.json'" },
  positive: { type: "string", description: "What the image/video should show" },
  negative: { type: "string", description: "What to avoid, optional" },
  promptNodeId: { type: ["string", "integer"], description: "Node ID of the positive CLIPTextEncode, optional" },
  filename: { type: "string", description: "Filename inside ComfyUI/input, e.g. 'myphoto.png'" },
  nodeId: { type: ["string", "integer"], description: "LoadImage node ID, optional" },
  image: { type: "string", description: "Filename in ComfyUI/input to load instead of the default" },
  seed: { type: ["integer", "string"], description: "Optional seed. Pass 'random' for a new seed." },
  steps: { type: "integer", description: "Optional sampling steps override" },
  width: { type: "integer" },
  height: { type: "integer" },
  limit: { type: "integer", description: "How many recent files, default 12" },
  sourcePath: { type: "string" },
  newName: { type: "string", description: "Optional filename to use in ComfyUI/input" },
};

const TOOLS_LIST = MCP_TOOLS.map(({ name, tool, args, required }) => ({
  name,
  description: TOOLS[tool].description,
  inputSchema: {
    type: "object",
    properties: Object.fromEntries(args.map((a) => [a, SCHEMAS[a] || { type: "string" }])),
    required: required || [],
  },
}));

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function replyErr(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

async function handle(msg) {
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      return reply(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "comfyui-studio", version: "1.0.0" },
        instructions: "Local ComfyUI control. Run comfyui_status first, then comfyui_list_workflows to see what the user can create.",
      });
    }
    if (method === "notifications/initialized") return;
    if (method === "ping") return reply(id, {});
    if (method === "tools/list") return reply(id, { tools: TOOLS_LIST });
    if (method === "tools/call") {
      const spec = MCP_TOOLS.find((t) => t.name === params.name);
      if (!spec) return replyErr(id, -32602, `Unknown tool: ${params.name}`);
      const raw = params.arguments || {};
      const args = {};
      for (const k of spec.args) if (raw[k] !== undefined) args[k] = raw[k];
      let result;
      try {
        result = await TOOLS[spec.tool].run(args);
      } catch (e) {
        result = { error: String(e.message || e) };
      }
      return reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: result && !!result.error });
    }
    if (id != null) replyErr(id, -32601, `Method not found: ${method}`);
  } catch (e) {
    if (id != null) replyErr(id, -32603, String(e.message || e));
  }
}
