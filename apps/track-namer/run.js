"use strict";

// Track Namer — asks a local Ollama model to name and describe a track.
// Args: { "mood": "dark synthwave", "genre": "electronic", "notes": "80s, slow build" }

const args = JSON.parse(process.argv[2] || "{}");
const mood = args.mood || "uplifting";
const genre = args.genre || "electronic";
const notes = args.notes || "";
const model = args.model || "llama3.2:3b";
const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";

const prompt = `Suggest 3 track names for a ${genre} piece with a ${mood} mood. ${notes ? "Notes: " + notes + "." : ""}
Reply with JSON only: {"names":[{"name":"...","tagline":"..."}]} — 3 entries, each name under 4 words, tagline under 10 words.`;

(async () => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 120000);
  try {
    const r = await fetch(OLLAMA + "/api/generate", {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false, format: "json" }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `ollama ${r.status}`);
    let parsed;
    try { parsed = JSON.parse(j.response); } catch { throw new Error("model did not return JSON: " + String(j.response).slice(0, 200)); }
    const names = (parsed.names || []).slice(0, 3).map((n) => ({
      name: String(n.name || "").slice(0, 60),
      tagline: String(n.tagline || "").slice(0, 120),
    }));
    if (!names.length) throw new Error("model returned no names");
    console.log(JSON.stringify({ model, mood, genre, names }));
  } catch (e) {
    console.log(JSON.stringify({ error: "Naming failed: " + e.message }));
    process.exitCode = 1;
  } finally { clearTimeout(t); }
})();
