// Royal Watch CMS API — Cloudflare Worker (no dependencies).
// Content (data/products.json, data/site.json, images/) lives in the GitHub repo and is changed
// through atomic commits; GitHub Pages republishes the site. Users and leads live in D1.

const enc = new TextEncoder();
const dec = new TextDecoder();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ------------------------------------------------------------------ utils */

const b64 = {
  enc(bytes) { let s = ""; const a = new Uint8Array(bytes); for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000)); return btoa(s); },
  dec(str) { const s = atob(str); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; },
  urlEnc(bytes) { return b64.enc(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
  urlDec(str) { return b64.dec(str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4)); },
};

function safeEqual(a, b) {
  const x = typeof a === "string" ? enc.encode(a) : a, y = typeof b === "string" ? enc.encode(b) : b;
  let d = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const local = env.ALLOW_LOCALHOST === "1" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!origin || !(allowed.includes(origin) || local)) return { vary: "Origin" };
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

async function readJson(request, maxBytes = 25 * 1024 * 1024) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > maxBytes) throw new HttpError(413, "Сұраныс тым үлкен");
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "Сұраныс тым үлкен");
  try { return JSON.parse(text || "{}"); } catch { throw new HttpError(400, "JSON дұрыс емес"); }
}

/* --------------------------------------------------------------- passwords */

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

export async function hashPassword(password, iterations = 20000) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const h = await pbkdf2(password, salt, iterations);
  return `pbkdf2$${iterations}$${b64.enc(salt)}$${b64.enc(h)}`;
}

async function verifyPassword(password, stored) {
  const [alg, iter, salt, hash] = String(stored || "").split("$");
  if (alg !== "pbkdf2" || !iter || !salt || !hash) return false;
  const h = await pbkdf2(password, b64.dec(salt), Number(iter));
  return safeEqual(h, b64.dec(hash));
}

/* --------------------------------------------------------------------- JWT */

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signJwt(payload, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const head = b64.urlEnc(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const data = head + "." + b64.urlEnc(enc.encode(JSON.stringify(body)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(data));
  return data + "." + b64.urlEnc(sig);
}

async function verifyJwt(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  let body;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64.urlDec(parts[2]), enc.encode(parts[0] + "." + parts[1]));
    if (!ok) return null;
    body = JSON.parse(dec.decode(b64.urlDec(parts[1])));
  } catch { return null; }
  if (!body.exp || body.exp < Math.floor(Date.now() / 1000)) return null;
  return body;
}

async function requireUser(request, env) {
  if (!env.JWT_SECRET) throw new HttpError(500, "JWT_SECRET орнатылмаған");
  const m = /^Bearer (.+)$/.exec(request.headers.get("Authorization") || "");
  const claims = m && (await verifyJwt(m[1], env.JWT_SECRET));
  if (!claims) throw new HttpError(401, "Қайта кіріңіз");
  const row = await env.DB.prepare("SELECT username, role FROM users WHERE username = ?").bind(claims.sub).first();
  if (!row) throw new HttpError(401, "Қайта кіріңіз");
  return { username: row.username, role: row.role };
}

/* ------------------------------------------------------------- GitHub store */

async function gh(env, path, init = {}) {
  if (!env.GITHUB_TOKEN) throw new HttpError(500, "GITHUB_TOKEN орнатылмаған");
  const base = env.GITHUB_API_BASE || "https://api.github.com";
  const res = await fetch(`${base}/repos/${env.GITHUB_REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "royalwatch-cms",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  return res;
}

async function ghJson(env, path, init) {
  const res = await gh(env, path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new HttpError(res.status === 409 || res.status === 422 ? 409 : 502, `GitHub ${res.status}: ${text.slice(0, 200)}`);
    err.ghStatus = res.status;
    throw err;
  }
  return res.json();
}

async function readRepoFile(env, path) {
  const branch = env.GITHUB_BRANCH || "main";
  const res = await gh(env, `/contents/${path}?ref=${encodeURIComponent(branch)}`);
  if (res.status === 404) return { sha: null, text: null };
  if (!res.ok) throw new HttpError(502, `GitHub ${res.status} (${path})`);
  const meta = await res.json();
  let text;
  if (meta.content && meta.encoding === "base64") text = dec.decode(b64.dec(meta.content.replace(/\n/g, "")));
  else {
    const raw = await gh(env, `/contents/${path}?ref=${encodeURIComponent(branch)}`, { headers: { Accept: "application/vnd.github.raw+json" } });
    text = await raw.text();
  }
  return { sha: meta.sha, text };
}

async function commitFiles(env, { message, files, deletes }) {
  const branch = env.GITHUB_BRANCH || "main";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ref = await ghJson(env, `/git/ref/heads/${branch}`);
      const parentSha = ref.object.sha;
      const parent = await ghJson(env, `/git/commits/${parentSha}`);
      const tree = [];
      let i = 0;
      async function worker() {
        while (i < files.length) {
          const f = files[i++];
          const blob = await ghJson(env, "/git/blobs", { method: "POST", body: JSON.stringify(f.base64 != null ? { content: f.base64, encoding: "base64" } : { content: f.text, encoding: "utf-8" }) });
          tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
        }
      }
      await Promise.all(Array.from({ length: Math.min(6, files.length) }, worker));
      for (const p of deletes) tree.push({ path: p, mode: "100644", type: "blob", sha: null });
      const newTree = await ghJson(env, "/git/trees", { method: "POST", body: JSON.stringify({ base_tree: parent.tree.sha, tree }) });
      const commit = await ghJson(env, "/git/commits", {
        method: "POST",
        body: JSON.stringify({ message, tree: newTree.sha, parents: [parentSha], author: { name: "Royal Watch CMS", email: "cms@royalwatch.kz" } }),
      });
      await ghJson(env, `/git/refs/heads/${branch}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });
      return commit.sha;
    } catch (e) {
      if (attempt === 0 && e.ghStatus === 422) continue; // someone moved the branch meanwhile: retry once
      throw e;
    }
  }
}

/* -------------------------------------------------------------- validation */

const IMG_PATH = /^images\/[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){0,3}\.(jpg|jpeg|png|webp)$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
const CATS = ["women", "accessory", "kz"];
const STATUSES = ["in_stock", "on_order", "sold"];

function str(v, max, field) {
  if (v == null) return "";
  if (typeof v !== "string" || v.length > max) throw new HttpError(400, `Жарамсыз өріс: ${field}`);
  return v;
}
function pair(v, max, field) {
  v = v || {};
  return { kk: str(v.kk, max, field + ".kk"), ru: str(v.ru, max, field + ".ru") };
}
function url(v, field, { allowHash = false } = {}) {
  v = str(v, 500, field).trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  if (allowHash && (v.startsWith("#") || v.startsWith("/"))) return v;
  throw new HttpError(400, `Жарамсыз сілтеме: ${field}`);
}

export function validateProducts(data) {
  if (!data || !Array.isArray(data.products)) throw new HttpError(400, "products массиві жоқ");
  if (data.products.length > 2000) throw new HttpError(400, "Тым көп өнім");
  const ids = new Set(), slugs = new Set();
  const products = data.products.map((p, n) => {
    const f = (x) => `products[${n}].${x}`;
    if (!p || typeof p !== "object") throw new HttpError(400, `Жарамсыз өнім #${n}`);
    if (!SLUG.test(p.id || "")) throw new HttpError(400, `Жарамсыз id: ${p.id}`);
    if (ids.has(p.id)) throw new HttpError(400, `Қайталанған id: ${p.id}`);
    ids.add(p.id);
    const slug = (p.seo && p.seo.slug) || p.id;
    if (!SLUG.test(slug)) throw new HttpError(400, `Жарамсыз slug: ${slug}`);
    if (slugs.has(slug)) throw new HttpError(400, `Қайталанған slug: ${slug}`);
    slugs.add(slug);
    const num = (v, name) => {
      if (v == null || v === "") return null;
      if (typeof v !== "number" || !isFinite(v) || v < 0 || v > 1e9) throw new HttpError(400, `Жарамсыз баға: ${f(name)}`);
      return Math.round(v);
    };
    const images = Array.isArray(p.images) ? p.images : [];
    if (images.length > 30) throw new HttpError(400, `Тым көп сурет: ${p.id}`);
    images.forEach((s) => { if (typeof s !== "string" || !IMG_PATH.test(s)) throw new HttpError(400, `Жарамсыз сурет жолы: ${s}`); });
    const specs = (Array.isArray(p.specs) ? p.specs : []).slice(0, 40).map((s, i) => pair(s, 200, f(`specs[${i}]`)));
    const cats = (Array.isArray(p.cats) ? p.cats : []).filter((c) => CATS.includes(c));
    const msg = p.msg || {};
    return {
      id: p.id,
      active: p.active !== false,
      brand: str(p.brand, 80, f("brand")),
      brandRu: str(p.brandRu, 80, f("brandRu")),
      name: pair(p.name, 200, f("name")),
      variant: str(p.variant, 120, f("variant")),
      price: num(p.price, "price"),
      promo: num(p.promo, "promo"),
      priceOnRequest: !!p.priceOnRequest,
      status: STATUSES.includes(p.status) ? p.status : "in_stock",
      cats,
      sku: str(p.sku, 80, f("sku")),
      tagline: pair(p.tagline, 2000, f("tagline")),
      specs,
      images,
      alt: pair(p.alt, 300, f("alt")),
      altPlain: str(p.altPlain, 300, f("altPlain")),
      msg: { buy: pair(msg.buy, 600, f("msg.buy")), info: pair(msg.info, 600, f("msg.info")) },
      seo: { slug, description: pair(p.seo && p.seo.description, 400, f("seo.description")) },
    };
  });
  return { version: 1, products };
}

export function validateSite(data, apiUrl) {
  if (!data || typeof data !== "object") throw new HttpError(400, "Site JSON жарамсыз");
  const c = data.contacts || {}, h = data.hero || {};
  const slides = (Array.isArray(h.slides) ? h.slides : []).slice(0, 2).map((s, i) => {
    const path = (k) => {
      const v = str(s && s[k], 200, `hero.slides[${i}].${k}`);
      if (v && !IMG_PATH.test(v)) throw new HttpError(400, `Жарамсыз сурет жолы: ${v}`);
      return v;
    };
    return { desktop: path("desktop"), mobile: path("mobile") };
  });
  while (slides.length < 2) slides.push({ desktop: "", mobile: "" });
  return {
    version: 1,
    api: apiUrl,
    contacts: {
      whatsapp: str(c.whatsapp, 20, "contacts.whatsapp").replace(/\D/g, ""),
      phone: str(c.phone, 40, "contacts.phone"),
      instagram: url(c.instagram, "contacts.instagram"),
      telegram: url(c.telegram, "contacts.telegram"),
      tiktok: url(c.tiktok, "contacts.tiktok"),
      address: pair(c.address, 300, "contacts.address"),
      map: url(c.map, "contacts.map"),
      hours: pair(c.hours, 200, "contacts.hours"),
    },
    hero: {
      eyebrow: pair(h.eyebrow, 120, "hero.eyebrow"),
      title: str(h.title, 120, "hero.title"),
      desc: pair(h.desc, 500, "hero.desc"),
      cta: { text: pair(h.cta && h.cta.text, 80, "hero.cta.text"), link: url(h.cta && h.cta.link, "hero.cta.link", { allowHash: true }) },
      slides,
    },
  };
}

const jsonText = (obj) => JSON.stringify(obj, null, 1) + "\n";

/* ------------------------------------------------------------------ routes */

const loginHits = new Map(); // best-effort per-isolate throttle; D1 lockout below is the real one

async function login(request, env) {
  if (!env.JWT_SECRET) throw new HttpError(500, "JWT_SECRET орнатылмаған");
  const { username, password } = await readJson(request, 10_000);
  const name = String(username || "").trim().toLowerCase();
  if (!name || !password) throw new HttpError(400, "Логин мен парольді енгізіңіз");
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const key = `${ip}|${name}`;
  const now = Math.floor(Date.now() / 1000);
  const rec = await env.DB.prepare("SELECT n, ts FROM login_attempts WHERE k = ?").bind(key).first();
  if (rec && rec.n >= 8 && now - rec.ts < 900) throw new HttpError(429, "Тым көп әрекет. 15 минуттан кейін қайталаңыз");
  const user = await env.DB.prepare("SELECT username, hash, role FROM users WHERE username = ?").bind(name).first();
  // always run a hash so timing does not reveal whether the user exists
  const ok = await verifyPassword(String(password), user ? user.hash : "pbkdf2$20000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  if (!user || !ok) {
    const n = rec && now - rec.ts < 900 ? rec.n + 1 : 1;
    await env.DB.prepare("INSERT INTO login_attempts (k, n, ts) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET n = excluded.n, ts = excluded.ts").bind(key, n, now).run();
    throw new HttpError(401, "Логин немесе пароль қате");
  }
  if (rec) await env.DB.prepare("DELETE FROM login_attempts WHERE k = ?").bind(key).run();
  const ttl = 12 * 3600;
  const token = await signJwt({ sub: user.username, role: user.role }, env.JWT_SECRET, ttl);
  return json({ token, user: { username: user.username, role: user.role }, expires: now + ttl });
}

async function getData(env) {
  const [p, s] = await Promise.all([readRepoFile(env, "data/products.json"), readRepoFile(env, "data/site.json")]);
  return {
    products: { sha: p.sha, data: p.text ? JSON.parse(p.text) : { version: 1, products: [] } },
    site: { sha: s.sha, data: s.text ? JSON.parse(s.text) : null },
  };
}

async function commit(request, env, user) {
  const body = await readJson(request);
  const apiUrl = new URL(request.url).origin;
  const message = String(body.message || "update").replace(/[\r\n]+/g, " ").slice(0, 100);
  const files = [], deletes = [];
  const incoming = Array.isArray(body.files) ? body.files : [];
  if (incoming.length > 60) throw new HttpError(400, "Тым көп файл");
  for (const f of incoming) {
    const path = String(f.path || "");
    if (path === "data/products.json") {
      files.push({ path, text: jsonText(validateProducts(typeof f.text === "string" ? JSON.parse(f.text) : f.json)) });
    } else if (path === "data/site.json") {
      files.push({ path, text: jsonText(validateSite(typeof f.text === "string" ? JSON.parse(f.text) : f.json, apiUrl)) });
    } else if (IMG_PATH.test(path) && !path.startsWith("images/categories/")) {
      const data = String(f.base64 || "").replace(/\s+/g, "");
      if (!data || data.length > 5_000_000) throw new HttpError(400, `Сурет тым үлкен немесе бос: ${path}`);
      files.push({ path, base64: data });
    } else {
      throw new HttpError(400, `Рұқсат етілмеген жол: ${path}`);
    }
  }
  for (const p of Array.isArray(body.deletes) ? body.deletes : []) {
    if (!IMG_PATH.test(p) || /^images\/(categories|hero)\//.test(p)) throw new HttpError(400, `Жоюға болмайды: ${p}`);
    deletes.push(p);
  }
  if (!files.length && !deletes.length) throw new HttpError(400, "Өзгеріс жоқ");
  // optimistic concurrency: refuse to overwrite a JSON file somebody else changed
  for (const [path, sha] of Object.entries(body.expect || {})) {
    if (!files.some((f) => f.path === path)) continue;
    const cur = await readRepoFile(env, path);
    if (cur.sha !== sha) throw new HttpError(409, "Деректер басқа жерде өзгерген. Бетті жаңартып, қайта көріңіз");
  }
  const sha = await commitFiles(env, { message: `CMS: ${message}\n\nEdited-by: ${user.username}`, files, deletes });
  const fresh = {};
  for (const f of files) if (f.path.endsWith(".json")) fresh[f.path] = (await readRepoFile(env, f.path)).sha;
  return json({ ok: true, commit: sha, shas: fresh });
}

const LEAD_TYPES = { buy: "Сатып алу басылды", info: "«Толығырақ» басылды", callback: "Кері қоңырау", order: "Тапсырыс" };
const leadHits = new Map();

function clip(v, n) { return String(v == null ? "" : v).replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, n); }

async function createLead(request, env, ctx) {
  const raw = await readJson(request, 20_000);
  const type = LEAD_TYPES[raw.type] ? raw.type : null;
  if (!type) throw new HttpError(400, "type");
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const now = Date.now();
  const hits = (leadHits.get(ip) || []).filter((t) => now - t < 60_000);
  if (hits.length >= 20) throw new HttpError(429, "Тым жиі");
  hits.push(now); leadHits.set(ip, hits);
  const dedupe = `${ip}|${type}|${raw.pid}`;
  if (leadHits.get(dedupe) && now - leadHits.get(dedupe) < 30_000) return json({ ok: true, dup: true });
  leadHits.set(dedupe, now);
  if (leadHits.size > 5000) leadHits.clear();
  const lead = {
    type,
    pid: clip(raw.pid, 100),
    title: clip(raw.title, 200),
    price: Number.isFinite(raw.price) ? Math.round(raw.price) : null,
    lang: raw.lang === "ru" ? "ru" : "kk",
    name: clip(raw.name, 100),
    phone: clip(raw.phone, 40),
    message: clip(raw.message, 1000),
  };
  const ipHash = b64.urlEnc(await crypto.subtle.digest("SHA-256", enc.encode(ip + (env.JWT_SECRET || "")))).slice(0, 16);
  await env.DB.prepare("INSERT INTO leads (type, pid, title, price, lang, name, phone, message, ip_hash) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(lead.type, lead.pid, lead.title, lead.price, lead.lang, lead.name, lead.phone, lead.message, ipHash).run();
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const lines = ["Royal Watch: жаңа өтінім", `Түрі: ${LEAD_TYPES[type]}`];
    if (lead.title) lines.push(`Тауар: ${lead.title}`);
    if (lead.price) lines.push(`Баға: ${String(lead.price).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} ₸`);
    if (lead.name) lines.push(`Аты: ${lead.name}`);
    if (lead.phone) lines.push(`Телефон: ${lead.phone}`);
    if (lead.message) lines.push(`Хабарлама: ${lead.message}`);
    lines.push(`Тіл: ${lead.lang === "ru" ? "орысша" : "қазақша"}`);
    const send = fetch(`${env.TELEGRAM_API_BASE || "https://api.telegram.org"}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: lines.join("\n") }),
    }).catch(() => {});
    ctx && ctx.waitUntil ? ctx.waitUntil(send) : await send;
  }
  return json({ ok: true });
}

async function listLeads(request, env) {
  const u = new URL(request.url);
  const status = u.searchParams.get("status") || "active";
  const where = status === "all" ? "" : status === "active" ? "WHERE status != 'deleted'" : "WHERE status = ?";
  const stmt = env.DB.prepare(`SELECT id, created, type, pid, title, price, lang, name, phone, message, status FROM leads ${where} ORDER BY id DESC LIMIT 500`);
  const { results } = await (status === "all" || status === "active" ? stmt : stmt.bind(status)).all();
  const counts = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM leads GROUP BY status").all();
  return json({ leads: results, counts: Object.fromEntries(counts.results.map((r) => [r.status, r.n])) });
}

async function leadCounts(env) {
  const counts = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM leads GROUP BY status").all();
  return json({ counts: Object.fromEntries(counts.results.map((r) => [r.status, r.n])) });
}

async function setLeadStatus(request, env, id) {
  const { status } = await readJson(request, 1000);
  if (!["new", "done", "deleted"].includes(status)) throw new HttpError(400, "status");
  await env.DB.prepare("UPDATE leads SET status = ? WHERE id = ?").bind(status, id).run();
  return json({ ok: true });
}

function checkNewPassword(pw) {
  if (typeof pw !== "string" || pw.length < 10) throw new HttpError(400, "Пароль кемінде 10 таңба болуы керек");
  if (pw.length > 200) throw new HttpError(400, "Пароль тым ұзын");
}

async function changeOwnPassword(request, env, user) {
  const { old, password } = await readJson(request, 2000);
  const row = await env.DB.prepare("SELECT hash FROM users WHERE username = ?").bind(user.username).first();
  if (!row || !(await verifyPassword(String(old || ""), row.hash))) throw new HttpError(403, "Ескі пароль қате");
  checkNewPassword(password);
  await env.DB.prepare("UPDATE users SET hash = ? WHERE username = ?").bind(await hashPassword(password, Number(env.PBKDF2_ITERATIONS) || 20000), user.username).run();
  return json({ ok: true });
}

async function usersApi(request, env, user, parts) {
  if (user.role !== "owner") throw new HttpError(403, "Тек иесі (owner) үшін");
  const iter = Number(env.PBKDF2_ITERATIONS) || 20000;
  if (request.method === "GET" && parts.length === 2) {
    const { results } = await env.DB.prepare("SELECT username, role, created FROM users ORDER BY created").all();
    return json({ users: results });
  }
  if (request.method === "POST" && parts.length === 2) {
    const { username, password, role } = await readJson(request, 2000);
    const name = String(username || "").trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(name)) throw new HttpError(400, "Логин: 3–40 символ (a-z, 0-9, . _ -)");
    checkNewPassword(password);
    const exists = await env.DB.prepare("SELECT 1 AS x FROM users WHERE username = ?").bind(name).first();
    if (exists) throw new HttpError(409, "Бұл логин бар");
    await env.DB.prepare("INSERT INTO users (username, hash, role) VALUES (?, ?, ?)").bind(name, await hashPassword(password, iter), role === "owner" ? "owner" : "editor").run();
    return json({ ok: true });
  }
  const target = decodeURIComponent(parts[2] || "").toLowerCase();
  if (request.method === "DELETE" && parts.length === 3) {
    if (target === user.username) throw new HttpError(400, "Өзіңізді жоя алмайсыз");
    await env.DB.prepare("DELETE FROM users WHERE username = ?").bind(target).run();
    return json({ ok: true });
  }
  if (request.method === "POST" && parts.length === 4 && parts[3] === "password") {
    const { password } = await readJson(request, 2000);
    checkNewPassword(password);
    await env.DB.prepare("UPDATE users SET hash = ? WHERE username = ?").bind(await hashPassword(password, iter), target).run();
    return json({ ok: true });
  }
  throw new HttpError(404, "Not found");
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean); // ["api", ...]
  if (parts[0] !== "api") throw new HttpError(404, "Not found");
  const route = parts[1] || "";
  const m = request.method;

  if (route === "health") return json({ ok: true });
  if (route === "login" && m === "POST") return login(request, env);
  if (route === "leads" && m === "POST" && parts.length === 2) return createLead(request, env, ctx);

  const user = await requireUser(request, env);
  if (route === "me" && m === "GET") return json({ user });
  if (route === "password" && m === "POST") return changeOwnPassword(request, env, user);
  if (route === "data" && m === "GET") return json(await getData(env));
  if (route === "commit" && m === "POST") return commit(request, env, user);
  if (route === "leads" && m === "GET" && parts[2] === "count") return leadCounts(env);
  if (route === "leads" && m === "GET") return listLeads(request, env);
  if (route === "leads" && m === "PATCH" && parts.length === 3) return setLeadStatus(request, env, Number(parts[2]));
  if (route === "users") return usersApi(request, env, user, parts);
  throw new HttpError(404, "Not found");
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      const res = await handle(request, env, ctx);
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
      return out;
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (!(e instanceof HttpError)) console.error(e && e.stack || e);
      return json({ error: e instanceof HttpError ? e.message : "Серверлік қате" }, status, cors);
    }
  },
};
