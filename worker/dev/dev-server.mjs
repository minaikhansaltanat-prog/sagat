// Local test harness (not deployed): a fake GitHub Git-Data API + a static server that overlays the
// "committed" files on top of the project root, so the admin can be exercised end to end without
// touching the real repository.   node worker/dev/dev-server.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const REPO = path.join(here, ".repo");
const GH_PORT = Number(process.env.GH_PORT || 8788), WEB_PORT = Number(process.env.WEB_PORT || 3001);
const rel = (p) => path.relative(REPO, p).split(path.sep).join("/");

const gitSha = (buf) => crypto.createHash("sha1").update(Buffer.concat([Buffer.from("blob " + buf.length + "\0"), buf])).digest("hex");
const rand = () => crypto.randomBytes(20).toString("hex");

let blobs, trees, commits, headTree, headCommit, log;
function seedAll() {
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.mkdirSync(path.join(REPO, "data"), { recursive: true });
  for (const f of ["products.json", "site.json"]) fs.copyFileSync(path.join(ROOT, "data", f), path.join(REPO, "data", f));
  blobs = new Map(); trees = new Map(); commits = new Map(); log = [];
  const snapshot = new Map();
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else { const b = fs.readFileSync(p); const s = gitSha(b); blobs.set(s, b); snapshot.set(rel(p), s); }
  });
  walk(REPO);
  headTree = rand(); trees.set(headTree, snapshot);
  headCommit = rand(); commits.set(headCommit, { tree: headTree });
}
seedAll();

function persist(map) {
  for (const [p, sha] of map) {
    const f = path.join(REPO, p);
    if (!fs.existsSync(f) || gitSha(fs.readFileSync(f)) !== sha) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, blobs.get(sha)); }
  }
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else if (!map.has(rel(p))) fs.rmSync(p);
  });
  walk(REPO);
}

function body(req) {
  return new Promise((res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => { const t = Buffer.concat(c).toString("utf8"); try { res(t ? JSON.parse(t) : {}); } catch { res({}); } }); });
}

const gh = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  const auth = req.headers.authorization;
  if (url.pathname.startsWith("/telegram") || url.pathname.includes("/sendMessage")) { const b = await body(req); log.push({ telegram: b }); return send(200, { ok: true }); }
  if (url.pathname === "/__reset") { seedAll(); return send(200, { ok: true }); }
  if (url.pathname === "/__log") return send(200, log);
  if (url.pathname === "/__head") return send(200, { headCommit, files: [...trees.get(headTree).keys()] });
  if (auth !== "Bearer dev") return send(401, { message: "Bad credentials" });
  const m = /^\/repos\/[^/]+\/[^/]+(\/.*)$/.exec(url.pathname);
  if (!m) return send(404, { message: "Not Found" });
  const p = m[1];
  const b = req.method === "GET" ? {} : await body(req);
  let r;
  if (req.method === "GET" && (r = /^\/git\/ref\/heads\/(.+)$/.exec(p))) return send(200, { object: { sha: headCommit } });
  if (req.method === "GET" && (r = /^\/git\/commits\/(.+)$/.exec(p))) { const c = commits.get(r[1]); return c ? send(200, { sha: r[1], tree: { sha: c.tree } }) : send(404, {}); }
  if (req.method === "POST" && p === "/git/blobs") {
    const buf = b.encoding === "base64" ? Buffer.from(b.content, "base64") : Buffer.from(b.content, "utf8");
    const s = gitSha(buf); blobs.set(s, buf); return send(201, { sha: s });
  }
  if (req.method === "POST" && p === "/git/trees") {
    const base = new Map(trees.get(b.base_tree) || []);
    for (const e of b.tree) { if (e.sha === null) base.delete(e.path); else base.set(e.path, e.sha); }
    const s = rand(); trees.set(s, base); return send(201, { sha: s });
  }
  if (req.method === "POST" && p === "/git/commits") { const s = rand(); commits.set(s, { tree: b.tree, message: b.message }); log.push({ commit: s, message: b.message }); return send(201, { sha: s }); }
  if (req.method === "PATCH" && (r = /^\/git\/refs\/heads\/(.+)$/.exec(p))) {
    const c = commits.get(b.sha); if (!c) return send(422, { message: "bad sha" });
    headCommit = b.sha; headTree = c.tree; persist(trees.get(headTree)); return send(200, {});
  }
  if (req.method === "GET" && (r = /^\/contents\/(.+)$/.exec(p))) {
    const file = decodeURIComponent(r[1]);
    const sha = trees.get(headTree).get(file);
    if (!sha) return send(404, { message: "Not Found" });
    const buf = blobs.get(sha);
    if ((req.headers.accept || "").includes("raw")) { res.writeHead(200, { "content-type": "text/plain" }); return res.end(buf); }
    return send(200, { sha, encoding: "base64", content: buf.toString("base64").replace(/(.{60})/g, "$1\n") });
  }
  send(404, { message: "Not Found " + p });
});
gh.listen(GH_PORT, "127.0.0.1", () => console.log("fake GitHub on", GH_PORT));

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const candidates = [path.join(REPO, p), path.join(ROOT, p)];
  const f = candidates.find((c) => c.startsWith(ROOT) && fs.existsSync(c) && fs.statSync(c).isFile());
  if (!f) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": MIME[path.extname(f).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(f).pipe(res);
}).listen(WEB_PORT, "127.0.0.1", () => console.log("site+admin overlay on", WEB_PORT));
