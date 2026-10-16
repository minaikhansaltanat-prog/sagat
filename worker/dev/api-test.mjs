// Integration test against `wrangler dev` (8787) + fake GitHub (8788).   node worker/dev/api-test.mjs
const API = "http://127.0.0.1:8787", GH = "http://127.0.0.1:8788";
let fails = 0;
const PID = "cso-watch-" + Date.now();
const ok = (c, msg) => { if (!c) { fails++; console.log("FAIL", msg); } else console.log("ok  ", msg); };
async function call(method, path, body, token, extra = {}) {
  const r = await fetch(API + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: "Bearer " + token } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j, headers: r.headers };
}

// --- auth
let r = await call("POST", "/api/login", { username: "admin", password: "wrong" });
ok(r.status === 401, "wrong password -> 401");
r = await call("POST", "/api/login", { username: "admin", password: "DevPassw0rd-123" });
ok(r.status === 200 && r.json.token, "login ok");
const T = r.json.token;
r = await call("GET", "/api/me", null, T);
ok(r.json.user.role === "owner", "me -> owner");
r = await call("GET", "/api/data");
ok(r.status === 401, "data without token -> 401");
r = await call("GET", "/api/data", null, "x.y.z");
ok(r.status === 401, "garbage token -> 401");

// --- CORS
r = await fetch(API + "/api/health", { headers: { Origin: "https://royalwatch.kz" } });
ok(r.headers.get("access-control-allow-origin") === "https://royalwatch.kz", "CORS allows royalwatch.kz");
r = await fetch(API + "/api/health", { headers: { Origin: "https://evil.example" } });
ok(!r.headers.get("access-control-allow-origin"), "CORS blocks other origins");

// --- read data
r = await call("GET", "/api/data", null, T);
ok(r.status === 200 && r.json.products.data.products.length === 85, "data: 85 products from GitHub");
ok(r.json.products.sha && r.json.site.sha, "data: shas present");
const prod = r.json.products;

// --- edit: add a product + upload an image
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const np = JSON.parse(JSON.stringify(prod.data.products[0]));
np.id = "test-watch"; np.seo = { slug: "test-watch", description: { kk: "", ru: "" } };
np.name = { kk: "Test", ru: "Тест" }; np.images = ["images/test-watch/a1.webp"]; np.price = 19000;
const next = { version: 1, products: [...prod.data.products, np] };
r = await call("POST", "/api/commit", { message: "add test watch", files: [{ path: "data/products.json", json: next }, { path: "images/test-watch/a1.webp", base64: PNG }], expect: { "data/products.json": prod.sha } }, T);
ok(r.status === 200 && r.json.commit, "commit with image ok: " + JSON.stringify(r.json).slice(0, 80));
const newSha = r.json.shas["data/products.json"];
r = await call("GET", "/api/data", null, T);
ok(r.json.products.data.products.length === 86 && r.json.products.data.products[85].id === "test-watch", "86 products after commit");
const head = await (await fetch(GH + "/__head")).json();
ok(head.files.includes("images/test-watch/a1.webp"), "image blob committed");

// --- concurrency
r = await call("POST", "/api/commit", { message: "stale", files: [{ path: "data/products.json", json: next }], expect: { "data/products.json": prod.sha } }, T);
ok(r.status === 409, "stale sha -> 409");

// --- validation / security
const bad = (obj, label, code = 400) => call("POST", "/api/commit", { message: "x", files: [obj] }, T).then((x) => ok(x.status === code, `${label} -> ${x.status}`));
await bad({ path: "index.html", text: "<script>" }, "write index.html rejected");
await bad({ path: "images/../x.png", base64: PNG }, "path traversal rejected");
await bad({ path: "images/categories/a.jpg", base64: PNG }, "write categories rejected");
await bad({ path: "data/products.json", json: { products: [{ id: "Bad Id" }] } }, "bad product id rejected");
await bad({ path: "data/products.json", json: { products: [{ id: "a", images: ["http://evil/x.jpg"] }] } }, "external image rejected");
await bad({ path: "data/site.json", json: { contacts: { instagram: "javascript:alert(1)" } } }, "javascript: url rejected");
r = await call("POST", "/api/commit", { message: "x", deletes: ["images/hero/d1.jpg"] }, T);
ok(r.status === 400, "delete hero image rejected");

// --- delete image
r = await call("POST", "/api/commit", { message: "rm", files: [{ path: "data/products.json", json: prod.data }], deletes: ["images/test-watch/a1.webp"], expect: { "data/products.json": newSha } }, T);
ok(r.status === 200, "delete + restore products ok");
const head2 = await (await fetch(GH + "/__head")).json();
ok(!head2.files.includes("images/test-watch/a1.webp"), "image removed from repo");

// --- site settings keep api = worker origin
const dd = await call("GET", "/api/data", null, T); if (!dd.json.site) console.log("DEBUG data:", dd.status, JSON.stringify(dd.json).slice(0, 200));
const site = dd.json.site;
const s2 = JSON.parse(JSON.stringify(site.data)); s2.api = "https://attacker.example"; s2.contacts.phone = "+7 700 000 00 00";
r = await call("POST", "/api/commit", { message: "site", files: [{ path: "data/site.json", json: s2 }], expect: { "data/site.json": site.sha } }, T);
ok(r.status === 200, "site commit ok");
const site2 = (await call("GET", "/api/data", null, T)).json.site.data;
ok(site2.api === API && site2.contacts.phone === "+7 700 000 00 00", "site.api forced to worker origin: " + site2.api);

// --- leads (public) + telegram
r = await call("POST", "/api/leads", { type: "buy", pid: PID, title: "CSO WATCH Steel Quartz, Graphite", price: 22000, lang: "kk" }, null, { origin: "https://royalwatch.kz" });
ok(r.status === 200, "public lead accepted");
r = await call("POST", "/api/leads", { type: "buy", pid: PID, title: "x" });
ok(r.json.dup === true, "duplicate lead ignored");
r = await call("POST", "/api/leads", { type: "hack" });
ok(r.status === 400, "bad lead type rejected");
r = await call("GET", "/api/leads", null, T);
ok(r.json.leads.length === 1 && r.json.leads[0].status === "new" && r.json.leads[0].price === 22000, "lead listed");
const id = r.json.leads[0].id;
r = await call("PATCH", "/api/leads/" + id, { status: "done" }, T);
ok(r.status === 200, "lead -> done");
r = await call("GET", "/api/leads?status=done", null, T);
ok(r.json.leads.length === 1, "filter done");
r = await call("PATCH", "/api/leads/" + id, { status: "deleted" }, T);
r = await call("GET", "/api/leads", null, T);
ok(r.json.leads.length === 0, "deleted lead hidden");
const log = await (await fetch(GH + "/__log")).json();
ok(log.some((l) => l.telegram && /Сатып алу/.test(l.telegram.text) && /22 000/.test(l.telegram.text)), "telegram message sent");

// --- users / passwords
r = await call("POST", "/api/login", { username: "client", password: "ClientPassw0rd-456" });
const C = r.json.token;
ok(r.status === 200 && r.json.user.role === "editor", "editor login");
r = await call("GET", "/api/users", null, C);
ok(r.status === 403, "editor cannot list users");
r = await call("GET", "/api/users", null, T);
ok(r.json.users.length >= 2, "owner lists users");
r = await call("POST", "/api/users", { username: "newbie", password: "short", role: "editor" }, T);
ok(r.status === 400, "weak password rejected");
r = await call("POST", "/api/users", { username: "newbie", password: "LongEnough-Pass1", role: "editor" }, T);
ok(r.status === 200, "owner creates user");
r = await call("POST", "/api/login", { username: "newbie", password: "LongEnough-Pass1" });
ok(r.status === 200, "new user can log in");
r = await call("POST", "/api/users/newbie/password", { password: "Another-Pass-77" }, T);
ok(r.status === 200, "owner resets password");
r = await call("POST", "/api/login", { username: "newbie", password: "Another-Pass-77" });
ok(r.status === 200, "login with reset password");
r = await call("POST", "/api/password", { old: "wrong", password: "Whatever-Pass-1" }, C);
ok(r.status === 403, "change own password needs old password");
r = await call("DELETE", "/api/users/newbie", null, T);
ok(r.status === 200, "owner deletes user");
r = await call("GET", "/api/me", null, r.json && C);
ok(r.status === 200, "editor token still valid");

// --- brute force lockout
for (let i = 0; i < 9; i++) await call("POST", "/api/login", { username: "client", password: "nope" + i });
r = await call("POST", "/api/login", { username: "client", password: "ClientPassw0rd-456" });
ok(r.status === 429, "lockout after repeated failures -> 429");

console.log(fails ? `\n${fails} FAILED` : "\nALL OK");
process.exit(fails ? 1 : 0);
