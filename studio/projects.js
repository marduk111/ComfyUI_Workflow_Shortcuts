"use strict";

// A "project" is a folder on this laptop holding everything one piece of work
// needs: the assets it started from, any workflow tuned for it, and the results
// it produced. Projects live next to the studio so they are easy to find,
// zip, or push to their own GitHub repository.
//
//   projects/<slug>/
//     project.json   name, description, history
//     assets/        photos/videos the user dropped in
//     workflows/     optional workflow JSONs tuned for this project
//     results/       everything the generator produced for it
//     README.md      plain-language summary of the project

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const pexec = promisify(execFile);

const ROOT = path.resolve(__dirname, "..");
const PROJECTS_DIR = path.join(ROOT, "projects");
const INPUT_DIR = require("./config.js").INPUT_DIR;

function slugify(name) {
  return String(name)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60) || "project";
}

function projectDir(slug) {
  return path.join(PROJECTS_DIR, slug);
}

function validSlug(slug) {
  return /^[a-z0-9][a-z0-9-]{0,59}$/.test(String(slug || ""));
}

function readMeta(slug) {
  const p = path.join(projectDir(slug), "project.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeMeta(slug, meta) {
  fs.writeFileSync(path.join(projectDir(slug), "project.json"), JSON.stringify(meta, null, 2));
}

function ensureProject(slug) {
  const meta = readMeta(slug);
  if (!meta) throw new Error(`No project named "${slug}". Run: node studio/studio.js projects`);
  return meta;
}

function writeReadme(slug, meta) {
  const lines = [
    `# ${meta.name}`,
    "",
    meta.description ? meta.description : "_No description yet._",
    "",
    "| Folder | What's in it |",
    "|---|---|",
    "| `assets/` | Photos and videos this project starts from |",
    "| `workflows/` | ComfyUI workflows tuned for this project |",
    "| `results/` | Everything the generator produced |",
    "",
    `- Created: ${meta.created}`,
    meta.github && meta.github.url ? `- GitHub: ${meta.github.url}` : "",
    "",
    "## Asset list",
    "",
  ];
  const assets = listFiles(path.join(projectDir(slug), "assets"));
  if (!assets.length) lines.push("_No assets yet._");
  else assets.forEach((f) => lines.push(`- \`${f.name}\` (${f.size} bytes)`));
  fs.writeFileSync(path.join(projectDir(slug), "README.md"), lines.filter((l) => l !== "").join("\n") + "\n");
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const full = path.join(dir, e.name);
      const st = fs.statSync(full);
      return { name: e.name, path: full, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function create({ name, description, workflow }) {
  if (!name || !String(name).trim()) return { error: "A project needs a name." };
  let slug = slugify(name);
  if (fs.existsSync(projectDir(slug))) return { error: `A project called "${slug}" already exists.` };
  fs.mkdirSync(path.join(projectDir(slug), "assets"), { recursive: true });
  fs.mkdirSync(path.join(projectDir(slug), "workflows"), { recursive: true });
  fs.mkdirSync(path.join(projectDir(slug), "results"), { recursive: true });
  const meta = {
    name: String(name).trim(),
    slug,
    description: description ? String(description) : "",
    workflow: workflow ? String(workflow) : "",
    created: new Date().toISOString().slice(0, 10),
    runs: 0,
  };
  writeMeta(slug, meta);
  writeReadme(slug, meta);
  return { created: true, ...meta, path: projectDir(slug) };
}

function list() {
  if (!fs.existsSync(PROJECTS_DIR)) return { projects: [], count: 0 };
  const projects = fs
    .readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && validSlug(e.name) && fs.existsSync(path.join(PROJECTS_DIR, e.name, "project.json")))
    .map((e) => {
      const meta = readMeta(e.name) || {};
      return {
        slug: e.name,
        name: meta.name || e.name,
        description: meta.description || "",
        workflow: meta.workflow || "",
        assets: listFiles(path.join(projectDir(e.name), "assets")).length,
        results: listFiles(path.join(projectDir(e.name), "results")).length,
        created: meta.created || "",
        github: (meta.github && meta.github.url) || "",
      };
    })
    .sort((a, b) => (a.created < b.created ? 1 : -1));
  return { count: projects.length, projects };
}

function info({ project }) {
  const slug = String(project || "").trim();
  if (!validSlug(slug)) return { error: `Not a project name: ${project}` };
  const meta = readMeta(slug);
  if (!meta) return { error: `No project named "${slug}". Run: node studio/studio.js projects` };
  return {
    ...meta,
    path: projectDir(slug),
    assets: listFiles(path.join(projectDir(slug), "assets")),
    workflows: listFiles(path.join(projectDir(slug), "workflows")),
    results: listFiles(path.join(projectDir(slug), "results")),
  };
}

// Copies an existing file into the project's assets and makes it usable by
// ComfyUI in the same step, so `run image=<name>` just works.
function addAsset({ project, sourcePath, name }) {
  const slug = String(project || "").trim();
  if (!validSlug(slug)) return { error: `Not a project name: ${project}` };
  const meta = readMeta(slug);
  if (!meta) return { error: `No project named "${slug}". Run: node studio/studio.js projects` };
  const src = String(sourcePath || "").trim();
  if (!src || !fs.existsSync(src)) return { error: `File not found: ${src}` };
  const base = path.basename(name || src);
  const dest = path.join(projectDir(slug), "assets", base);
  fs.copyFileSync(src, dest);
  let comfyPath = null;
  try {
    comfyPath = path.join(INPUT_DIR, base);
    fs.copyFileSync(src, comfyPath);
  } catch {}
  meta.updated = new Date().toISOString().slice(0, 10);
  writeMeta(slug, meta);
  writeReadme(slug, meta);
  return { added: true, project: slug, filename: base, path: dest, comfyInput: comfyPath };
}

// Moves fresh generator output into the project folder so everything for a
// project ends up in one place. Files already there are kept unless overwrite.
function collectResults({ project, files, since }) {
  const slug = String(project || "").trim();
  if (!validSlug(slug)) return { error: `Not a project name: ${project}` };
  const meta = readMeta(slug);
  if (!meta) return { error: `No project named "${slug}". Run: node studio/studio.js projects` };
  const outDir = path.join(projectDir(slug), "results");
  fs.mkdirSync(outDir, { recursive: true });
  const copied = [];
  for (const f of files || []) {
    const full = f.path || f;
    if (!full || !fs.existsSync(full)) continue;
    if (since && fs.statSync(full).mtimeMs < since) continue;
    const base = path.basename(full);
    let dest = path.join(outDir, base);
    if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(full).size) continue;
    fs.copyFileSync(full, dest);
    copied.push({ name: base, path: dest, size: fs.statSync(dest).size });
  }
  if (copied.length) {
    meta.runs = (meta.runs || 0) + 1;
    meta.updated = new Date().toISOString().slice(0, 10);
    writeMeta(slug, meta);
    writeReadme(slug, meta);
  }
  return { project: slug, copied: copied.length, results: copied, totalResults: listFiles(outDir).length };
}

function allOutputFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) allOutputFiles(full, out);
    else out.push({ name: e.name, path: full, mtime: fs.statSync(full).mtimeMs, size: fs.statSync(full).size });
  }
  return out;
}

/* --------------------------- git / GitHub --------------------------- */
// Every project is a self-contained folder, so each one can be its own
// repository. Publishing is two steps:
//   1. local  - git init + commit (always safe, never leaves the laptop)
//   2. remote - gh repo create + push (only when create=true is asked for)

async function sh(cwd, cmd, args, timeoutMs = 60000) {
  try {
    const { stdout, stderr } = await pexec(cmd, args, { cwd, windowsHide: true, timeout: timeoutMs });
    return { ok: true, out: String(stdout || "").trim(), err: String(stderr || "").trim() };
  } catch (e) {
    return {
      ok: false,
      out: String(e.stdout || "").trim(),
      err: String(e.stderr || e.message || "").trim(),
    };
  }
}

function truthy(v) {
  return v === true || v === 1 || v === "1" || v === "true" || v === "yes";
}

// Heavy generated files stay out of git by default - they are big and regenerable.
function writeGitignore(dir, includeAssets) {
  const lines = [
    "# Generated output and raw source media (regenerable / large)",
    ...(includeAssets ? [] : ["assets/"]),
    "results/",
    "Thumbs.db",
    ".DS_Store",
    "",
  ];
  const file = path.join(dir, ".gitignore");
  const next = lines.join("\n");
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== next) fs.writeFileSync(file, next);
}

async function publish({ project, create, visibility, includeAssets, message }) {
  const slug = String(project || "").trim();
  if (!validSlug(slug)) return { error: `Not a project name: ${project}` };
  const meta = readMeta(slug);
  if (!meta) return { error: `No project named "${slug}". Run: node studio/studio.js projects` };
  const dir = projectDir(slug);

  writeGitignore(dir, truthy(includeAssets));

  let gitInit = false;
  if (!(await sh(dir, "git", ["rev-parse", "--is-inside-work-tree"])).ok) {
    const init = await sh(dir, "git", ["init"]);
    if (!init.ok) return { error: `git init failed: ${init.err}` };
    gitInit = true;
  }

  await sh(dir, "git", ["add", "-A"]);
  const status = await sh(dir, "git", ["status", "--porcelain"]);
  const pending = status.ok ? status.out.split(/\r?\n/).filter(Boolean) : [];

  let committed = false;
  if (pending.length) {
    const msg = String(message || `Update ${slug} (${new Date().toISOString().slice(0, 10)})`);
    const c = await sh(dir, "git", ["commit", "-m", msg]);
    if (!c.ok) return { error: `git commit failed: ${c.err || c.out}` };
    committed = true;
  }

  const head = await sh(dir, "git", ["rev-parse", "--short", "HEAD"]);
  const remote = await sh(dir, "git", ["remote", "get-url", "origin"]);
  let repoUrl = remote.ok ? remote.out.replace(/^git@github\.com:/, "https://github.com/") : "";
  if (repoUrl.endsWith(".git")) repoUrl = repoUrl.slice(0, -4);

  let created = false;
  let createdError = null;
  if (truthy(create) && !remote.ok) {
    const vis = visibility === "public" ? "--public" : "--private";
    const r = await sh(dir, "gh", ["repo", "create", slug, vis, "--source", ".", "--push"], 180000);
    if (r.ok) {
      created = true;
      const view = await sh(dir, "gh", ["repo", "view", slug, "--json", "url"]);
      if (view.ok) repoUrl = JSON.parse(view.out || "{}").url || repoUrl;
    } else {
      createdError = r.err || r.out;
    }
  }

  if (repoUrl) {
    meta.github = { url: repoUrl, repo: slug, pushed: new Date().toISOString().slice(0, 10) };
    writeMeta(slug, meta);
    writeReadme(slug, meta);
  }

  const out = {
    project: slug,
    gitInit,
    committed,
    changed: pending.length,
    branch: (await sh(dir, "git", ["rev-parse", "--abbrev-ref", "HEAD"])).out || "",
    commit: head.out || null,
    remote: repoUrl || null,
    created,
    localOnly: !truthy(create),
  };
  if (createdError) out.createdError = createdError;
  if (createdError) {
    out.hint = "Local snapshot saved. GitHub was not updated - say 'publish it to GitHub' if you want that.";
  } else if (!truthy(create)) {
    out.hint = "Local snapshot only. To put it on GitHub too: project_publish project=" + slug + " create=true";
  } else if (created) {
    out.hint = "Published. Repo: " + repoUrl;
  }
  return out;
}

module.exports = { create, list, info, addAsset, collectResults, allOutputFiles, publish, PROJECTS_DIR, projectDir, validSlug, readMeta, writeMeta, writeReadme };
