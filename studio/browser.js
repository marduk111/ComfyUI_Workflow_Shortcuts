"use strict";

// ============================================================
// Browser bridge — the studio's hands on websites.
//
// Gives the AI the ability to use a website exactly as the human
// would: a real browser with a persistent profile (logins survive
// restarts), driving pages, reading them back, and — crucially for
// reverse engineering — recording every network request a site
// makes so we can see the APIs hiding behind the buttons.
//
// Runs inside the long-lived studio server (state survives across
// CLI calls). The `web` CLI tool forwards here over HTTP.
//
//   web action=goto url="https://..."      open a page
//   web action=inspect                    what's on this page (links, forms, scripts)
//   web action=click selector="text=Send" click something (css or text= selector)
//   web action=type selector="#q" text="hi"
//   web action=read                       visible text of the page
//   web action=screenshot                 save a PNG (served at /shots/<name>.png)
//   web action=harvest on|off             record network traffic (reverse engineering)
//   web action=harvest_log                what got recorded
//   web action=cookies domain=...         cookies for a site (for API building)
//   web action=fetch url=... method=...   fetch INSIDE the page (uses the site's own login)
//   web action=close                      shut the browser down
// ============================================================

const fs = require("fs");
const path = require("path");

const DATA = path.join(__dirname, "data");
const PROFILE = path.join(DATA, "browser-profile");   // logins live here
const SHOTS = path.join(DATA, "shots");
const HARVEST = path.join(DATA, "harvest.jsonl");

let chromium = null;
let browser = null;      // the persistent browser context (acts like a real profiled Edge)
let page = null;         // the current tab
let launching = null;    // in-flight launch promise (avoid double launch)
let harvestOn = false;
const harvestLog = [];
let chain = Promise.resolve();  // serialize actions — one page, one story at a time

function enqueue(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

async function loadPlaywright() {
  if (chromium) return chromium;
  try {
    ({ chromium } = require("playwright-core"));
    return chromium;
  } catch (e) {
    throw new Error("playwright-core is not installed in the studio folder. Run: npm install (in the studio root). " + e.message);
  }
}

async function ensureBrowser(opts = {}) {
  if (browser && page && !page.isClosed()) return;
  if (launching) return launching;
  launching = (async () => {
    const c = await loadPlaywright();
    fs.mkdirSync(PROFILE, { recursive: true });
    fs.mkdirSync(SHOTS, { recursive: true });
    // System Edge through a persistent profile: the human logs in once,
    // the session is theirs from then on. Headful by default so they can
    // see (and fix) anything the AI is doing.
    browser = await c.launchPersistentContext(PROFILE, {
      channel: "msedge",
      headless: !!opts.headless,
      viewport: { width: 1280, height: 900 },
      acceptDownloads: true,
    });
    browser.on("close", () => { browser = null; page = null; harvestOn = false; });
    const pages = browser.pages();
    page = pages[0] || await browser.newPage();
    wireHarvest(page);
    return;
  })().finally(() => { launching = null; });
  return launching;
}

// Record every response the page makes. XHR/fetch bodies are kept (truncated)
// because those are the API calls we want to imitate later.
function wireHarvest(p) {
  p.on("response", async (res) => {
    if (!harvestOn) return;
    try {
      const req = res.request();
      const entry = {
        at: new Date().toISOString(),
        method: req.method(),
        url: res.url(),
        status: res.status(),
        type: req.resourceType(),
      };
      if (req.resourceType() === "xhr" || req.resourceType() === "fetch") {
        const rh = req.headers();
        entry.requestHeaders = {
          "content-type": rh["content-type"],
          authorization: rh.authorization ? String(rh.authorization).slice(0, 80) + "…" : undefined,
        };
        try { entry.postData = (req.postData() || "").slice(0, 4000) || undefined; } catch {}
        try { entry.response = (await res.text()).slice(0, 8000); } catch {}
      }
      harvestLog.push(entry);
      try { fs.appendFileSync(HARVEST, JSON.stringify(entry) + "\n"); } catch {}
      if (harvestLog.length > 2000) harvestLog.shift();
    } catch {}
  });
}

async function ensureHarvestPage() {
  await ensureBrowser();
  // a fresh tab may have been opened by the human — follow it
  const pages = browser.pages();
  const current = pages[pages.length - 1];
  if (current && current !== page) {
    page = current;
    wireHarvest(page);
  }
}

function sel(selector) {
  // convenience: bare words become text= selectors
  if (!selector) return null;
  if (/^(text|css|xpath|id)=/.test(selector)) return selector;
  if (selector.startsWith("#") || selector.startsWith(".") || selector.includes("[") || selector.includes(" ") || selector.includes(">")) return selector;
  return "text=" + selector;
}

const actions = {
  async goto({ url, wait = "domcontentloaded" }) {
    if (!url) return { error: "url is required" };
    await ensureBrowser();
    await page.goto(url, { waitUntil: wait, timeout: 60000 });
    return { ok: true, url: page.url(), title: await page.title() };
  },

  async inspect() {
    await ensureHarvestPage();
    const data = await page.evaluate(() => {
      const links = [...document.querySelectorAll("a[href]")].slice(0, 60).map((a) => ({
        text: (a.textContent || "").trim().slice(0, 60), href: a.href,
      })).filter((l) => l.text);
      const buttons = [...document.querySelectorAll("button, [role=button], input[type=submit]")].slice(0, 40)
        .map((b) => (b.textContent || b.value || "").trim().slice(0, 60)).filter(Boolean);
      const forms = [...document.querySelectorAll("form")].map((f) => ({
        action: f.action, method: f.method,
        fields: [...f.querySelectorAll("input,select,textarea")].map((i) => i.name || i.id || i.type).filter(Boolean),
      }));
      const scripts = [...document.querySelectorAll("script[src]")].map((s) => s.src).slice(0, 30);
      const inputs = [...document.querySelectorAll("input,textarea,select")].slice(0, 40).map((i) => ({
        tag: i.tagName.toLowerCase(), type: i.type, name: i.name || i.id || null,
        placeholder: i.placeholder || null,
      }));
      return { title: document.title, url: location.href, links, buttons, forms, inputs, scripts };
    });
    return data;
  },

  async read({ selector, limit = 6000 } = {}) {
    await ensureHarvestPage();
    const s = sel(selector);
    const text = s
      ? await page.locator(s).first().innerText().catch(() => null)
      : await page.innerText("body").catch(() => null);
    if (text == null) return { error: `nothing matched ${selector}` };
    return { url: page.url(), text: text.slice(0, Number(limit)) };
  },

  async click({ selector, timeout = 15000 }) {
    const s = sel(selector);
    if (!s) return { error: "selector is required" };
    await ensureHarvestPage();
    await page.locator(s).first().click({ timeout: Number(timeout) });
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    return { ok: true, url: page.url(), title: await page.title() };
  },

  async type({ selector, text, submit = false }) {
    const s = sel(selector);
    if (!s || text == null) return { error: "selector and text are required" };
    await ensureHarvestPage();
    await page.locator(s).first().fill(String(text), { timeout: 15000 });
    if (submit === true || submit === "true") {
      await page.keyboard.press("Enter");
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    }
    return { ok: true, url: page.url() };
  },

  async eval({ script }) {
    if (!script) return { error: "script is required" };
    await ensureHarvestPage();
    // Evaluate a JS expression in the page — the AI's remote hand.
    const result = await page.evaluate((src) => {
      // eslint-disable-next-line no-eval
      return JSON.parse(JSON.stringify(eval(src), (k, v) => (v instanceof Node ? undefined : v)));
    }, script);
    return { result };
  },

  async screenshot({ name } = {}) {
    await ensureHarvestPage();
    fs.mkdirSync(SHOTS, { recursive: true });
    const file = (name || "shot-" + Date.now()) + ".png";
    const full = path.join(SHOTS, path.basename(file));
    await page.screenshot({ path: full, fullPage: false });
    return { ok: true, file: path.basename(full), url: `/shots/${path.basename(full)}` };
  },

  async harvest({ mode }) {
    await ensureBrowser();
    if (mode === "on" || mode === true || mode === "true") {
      harvestOn = true;
      harvestLog.length = 0;
      try { fs.writeFileSync(HARVEST, ""); } catch {}
      return { ok: true, recording: true, note: "Every XHR/fetch the page makes is now recorded. Do your thing on the site, then harvest_log." };
    }
    harvestOn = false;
    return { ok: true, recording: false, count: harvestLog.length };
  },

  async harvest_log({ limit = 60 } = {}) {
    const api = harvestLog.filter((e) => e.type === "xhr" || e.type === "fetch");
    return {
      recording: harvestOn,
      total: harvestLog.length,
      apiCalls: api.slice(-Number(limit)).map((e) => ({
        method: e.method, url: e.url, status: e.status,
        postData: e.postData, response: e.response ? e.response.slice(0, 1500) : undefined,
      })),
    };
  },

  async cookies({ domain } = {}) {
    await ensureBrowser();
    const all = await browser.cookies();
    const list = domain ? all.filter((c) => c.domain.includes(domain)) : all;
    return {
      count: list.length,
      cookies: list.map((c) => ({ name: c.name, domain: c.domain, value: c.value.slice(0, 120) })),
    };
  },

  // fetch from inside the page: same origin, same cookies, same login.
  // This is what makes a reverse-engineered API usable without copying tokens.
  async fetch({ url, method = "GET", headers, body }) {
    if (!url) return { error: "url is required" };
    await ensureHarvestPage();
    const out = await page.evaluate(async ({ url, method, headers, body }) => {
      try {
        const init = { method, headers: headers || {} };
        if (body != null && method !== "GET" && method !== "HEAD") {
          init.body = typeof body === "string" ? body : JSON.stringify(body);
          if (!init.headers["content-type"] && !init.headers["Content-Type"]) {
            init.headers["Content-Type"] = "application/json";
          }
        }
        const r = await fetch(url, init);
        const text = await r.text();
        return { status: r.status, body: text.slice(0, 20000) };
      } catch (e) {
        return { error: String(e.message || e) };
      }
    }, { url, method, headers: typeof headers === "string" ? JSON.parse(headers || "{}") : (headers || {}), body });
    return out;
  },

  async close() {
    if (browser) await browser.close().catch(() => {});
    browser = null; page = null; harvestOn = false; harvestLog.length = 0;
    return { ok: true, closed: true };
  },

  async status() {
    return {
      open: !!(browser && page && !page.isClosed()),
      url: page && !page.isClosed() ? page.url() : null,
      title: page && !page.isClosed() ? await page.title().catch(() => null) : null,
      recording: harvestOn,
      harvested: harvestLog.length,
      profile: PROFILE,
    };
  },
};

async function run(action, args = {}) {
  const fn = actions[action];
  if (!fn) {
    return {
      error: `Unknown web action "${action}"`,
      available: Object.keys(actions),
    };
  }
  return enqueue(() => fn(args || {}));
}

module.exports = { run, actions: Object.keys(actions), PROFILE, SHOTS };
