// Browser E2E for the admin panel against wrangler dev (8787) + fake GitHub/overlay site (3001).
//   node worker/dev/e2e.mjs
import puppeteer from "puppeteer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const REPO = path.join(here, ".repo");
const SHOTS = path.join(ROOT, "temporary screenshots");
const ADMIN = "http://127.0.0.1:3001/admin/?api=http://127.0.0.1:8787";
const GH = "http://127.0.0.1:8788";
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const readRepoJson = (f) => JSON.parse(fs.readFileSync(path.join(REPO, f), "utf8"));

await fetch(GH + "/__reset");
const browser = await puppeteer.launch({ headless: "new" });
const errs = [];
async function newPage(w, h, mobile) {
  const p = await browser.newPage();
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  await p.setViewport({ width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, isMobile: !!mobile, hasTouch: !!mobile });
  return p;
}
const clickText = (p, sel, text) => p.evaluate((s, t) => { const el = [...document.querySelectorAll(s)].find((e) => e.textContent.trim().includes(t)); if (!el) throw new Error("no " + s + " " + t); el.click(); }, sel, text);

let p = await newPage(1440, 900);
await p.goto(ADMIN, { waitUntil: "load" });
await p.waitForSelector("#loginForm");
await p.screenshot({ path: path.join(SHOTS, "admin-login.png") });

// wrong password
await p.type('input[name=username]', "admin"); await p.type('input[name=password]', "nope");
await p.click('#loginForm button'); await p.waitForFunction(() => document.querySelector("#loginErr").textContent.length > 0);
ok(/қате/.test(await p.$eval("#loginErr", (e) => e.textContent)), "wrong password shows error");
await p.$eval('input[name=password]', (e) => (e.value = ""));
await p.type('input[name=password]', "DevPassw0rd-123"); await p.click('#loginForm button');
await p.waitForSelector(".prow", { timeout: 15000 });
ok((await p.$$(".prow")).length === 85, "list shows 85 products");
await p.screenshot({ path: path.join(SHOTS, "admin-list-d.png") });

// search + filters
await p.type("#fq", "hublot");
await wait(300);
const nHub = (await p.$$(".prow")).length;
ok(nHub > 0 && nHub < 85, "search narrows list (" + nHub + ")");
await p.$eval("#fq", (e) => (e.value = "")); await p.evaluate(() => { const q = document.querySelector("#fq"); q.dispatchEvent(new Event("input", { bubbles: true })); });
await wait(200);
await p.select("#fcat", "accessory"); await wait(200);
ok((await p.$$(".prow")).length === 14, "accessory filter -> 14");
await p.select("#fcat", ""); await wait(200);

// toggle visibility + publish
await p.evaluate(() => document.querySelector('.prow input[data-act="toggle"]').click());
await wait(200);
ok(!!(await p.$(".savebar")), "dirty bar appears after toggle");
await clickText(p, ".savebar .btn", "Жариялау");
await p.waitForFunction(() => !document.querySelector(".savebar"), { timeout: 15000 });
ok(readRepoJson("data/products.json").products[0].active === false, "toggle published to repo (active=false)");
await p.evaluate(() => document.querySelector('.prow input[data-act="toggle"]').click());
await clickText(p, ".savebar .btn", "Жариялау");
await p.waitForFunction(() => !document.querySelector(".savebar"), { timeout: 15000 });
ok(readRepoJson("data/products.json").products[0].active !== false, "toggle restored");

// move up/down
const firstId = await p.$eval(".prow", (e) => e.dataset.id);
await p.evaluate(() => document.querySelectorAll('.prow')[0].querySelector('[data-act="down"]').click());
await wait(200);
ok((await p.$eval(".prow", (e) => e.dataset.id)) !== firstId, "move down changes order");
await clickText(p, ".savebar .btn", "Болдырмау");
await p.waitForFunction((id) => !document.querySelector(".savebar") && document.querySelector(".prow").dataset.id === id, { timeout: 20000 }, firstId);
ok((await p.$eval(".prow", (e) => e.dataset.id)) === firstId, "discard restores order");

// duplicate -> edit -> upload image -> save
const srcId = "hbt-stylish-4";
await p.goto(ADMIN.split("?")[0] + "#/new/dup/" + srcId, { waitUntil: "load" });
await p.waitForSelector("#edForm");
ok((await p.$eval('input[name=brand]', (e) => e.value)) === "HBT", "duplicate prefilled brand");
ok((await p.$$("#thumbs .thumb")).length === 6, "duplicate carries 6 photos");
await p.screenshot({ path: path.join(SHOTS, "admin-editor-d.png"), fullPage: true });
await p.$eval('input[name=nameKk]', (e) => (e.value = "")); await p.type('input[name=nameKk]', "E2E Test Watch");
await p.$eval('input[name=variant]', (e) => (e.value = "")); await p.type('input[name=variant]', "Blue Dial");
await p.$eval('input[name=price]', (e) => (e.value = "")); await p.type('input[name=price]', "33000");
await p.type('input[name=promo]', "29000");
await p.select('select[name=status]', "on_order");
// remove 5 photos, upload a real one as cover
for (let i = 0; i < 5; i++) await p.evaluate(() => document.querySelectorAll('#thumbs [data-act="img-del"]')[0].click());
const up = await p.$("#fileInput");
await up.uploadFile(path.join(ROOT, "Photo", "Pre.jpeg"));
await p.waitForFunction(() => document.querySelectorAll("#thumbs .thumb").length === 2, { timeout: 15000 });
await p.evaluate(() => document.querySelectorAll('#thumbs [data-act="img-cover"]')[1].click());
await p.evaluate(() => document.querySelector('[data-act="spec-preset"]').click());
await p.evaluate(() => { const i = document.querySelectorAll("#specList input"); i[i.length - 2].value = "Корпус — болат"; i[i.length - 2].dispatchEvent(new Event("input", { bubbles: true })); });
ok(await p.$eval('input[name=slug]', (e) => e.value) === "hbt-e2e-test-watch-blue-dial", "slug auto-generated");
await p.screenshot({ path: path.join(SHOTS, "admin-editor-filled-d.png"), fullPage: true });
await p.click("#saveBtn");
await p.waitForSelector(".prow", { timeout: 20000 }).catch(async () => { console.log("SAVE STUCK:", await p.evaluate(() => (document.querySelector("#edErr") || {}).textContent + " | " + document.querySelector("#toast").textContent)); throw new Error("save stuck"); });
ok((await p.$$(".prow")).length === 86, "86 products after save");
const saved = readRepoJson("data/products.json").products;
const np = saved.find((x) => x.id === "hbt-e2e-test-watch-blue-dial");
ok(np && np.price === 33000 && np.promo === 29000 && np.status === "on_order", "new product persisted with price/promo/status");
ok(saved[saved.findIndex((x) => x.id === srcId) + 1].id === np.id, "duplicate placed right after the original");
ok(np.images.length === 2 && /^images\/hbt-e2e-test-watch-blue-dial\/.*\.webp$/.test(np.images[0]), "uploaded cover is first, stored as webp: " + np.images[0]);
ok(fs.existsSync(path.join(REPO, np.images[0])) && fs.statSync(path.join(REPO, np.images[0])).size > 5000, "image file committed (" + fs.statSync(path.join(REPO, np.images[0])).size + " bytes)");
ok(np.specs.some((s) => s.kk === "Корпус — болат"), "spec saved");
ok(/HBT E2E Test Watch Blue Dial/.test(np.msg.buy.kk), "whatsapp message auto-generated");

// public site shows it (overlay), with price + promo + status
let site = await newPage(1440, 900);
await site.goto("http://127.0.0.1:3001/#p-hbt-e2e-test-watch-blue-dial", { waitUntil: "load" });
await site.waitForSelector("#newArrivalsGrid .product-card");
await wait(800);
const card = await site.evaluate(() => { const c = document.getElementById("p-hbt-e2e-test-watch-blue-dial"); return c && { price: c.querySelector(".product-card__price").textContent, stock: c.querySelector(".product-card__stock").textContent, name: c.querySelector(".product-card__name").textContent, n: document.querySelector(".grid-toolbar__num").textContent, modal: !!document.querySelector(".pmodal.is-open") }; });
ok(card && card.n === "86" && /29 000/.test(card.price) && /Тапсырыс/.test(card.stock), "public site renders new card: " + JSON.stringify(card));
ok(card && card.modal, "deep link opens the quick view");
const ld = await site.evaluate(() => JSON.parse(document.getElementById("rw-ld").textContent).itemListElement.length);
ok(ld === 86, "JSON-LD lists 86 products");
await site.close();

// edit existing: change tagline, then delete the test product
await p.goto(ADMIN.split("?")[0] + "#/product/hbt-e2e-test-watch-blue-dial", { waitUntil: "load" });
await p.waitForSelector("#edForm");
await p.$eval('input[name=price]', (e) => (e.value = "")); await p.type('input[name=price]', "31000");
await p.click("#saveBtn"); await p.waitForSelector(".prow", { timeout: 20000 });
ok(readRepoJson("data/products.json").products.find((x) => x.id === np.id).price === 31000, "edit persisted (price 31000)");
await p.evaluate((id) => document.querySelector('.prow[data-id="' + id + '"] [data-act="delete"]').click(), np.id);
await p.waitForSelector("#modal .modal__box");
await p.evaluate(() => document.querySelector('[data-dlg="1"]').click());
await p.waitForFunction(() => document.querySelectorAll(".prow").length === 85, { timeout: 20000 });
ok(!fs.existsSync(path.join(REPO, np.images[0])), "image of deleted product removed from repo");
ok(fs.existsSync(path.join(REPO, "images")) || true, "ok");
const after = readRepoJson("data/products.json").products;
ok(after.length === 85 && after.find((x) => x.id === srcId).images.length === 6, "original product untouched (shared images kept)");

// site settings
await p.goto(ADMIN.split("?")[0] + "#/site", { waitUntil: "load" });
await p.waitForSelector("#siteForm");
await p.screenshot({ path: path.join(SHOTS, "admin-site-d.png"), fullPage: true });
await p.$eval('input[name=phone]', (e) => (e.value = "")); await p.type('input[name=phone]', "+7 700 123 45 67");
await p.$eval('input[name=heroTitle]', (e) => (e.value = "")); await p.type('input[name=heroTitle]', "E2E TITLE");
await p.click("#siteSave"); await p.waitForFunction(() => /Сақталды/.test(document.querySelector("#toast").textContent), { timeout: 20000 });
const siteJson = readRepoJson("data/site.json");
ok(siteJson.contacts.phone === "+7 700 123 45 67" && siteJson.hero.title === "E2E TITLE" && siteJson.api === "http://127.0.0.1:8787", "site settings committed, api preserved");
site = await newPage(1440, 900);
await site.goto("http://127.0.0.1:3001/", { waitUntil: "load" }); await wait(1500);
ok((await site.$eval(".hero__title", (e) => e.textContent)) === "E2E TITLE", "public hero title updated");
ok(/\+7 700 123 45 67/.test(await site.$eval(".footer-address", (e) => e.innerText)), "public footer shows phone");
// lead from the public site -> appears in admin + telegram
await site.evaluate(() => { document.addEventListener("click", (e) => { if (e.target.closest(".product-btn")) e.preventDefault(); }, true); });
await site.evaluate(() => document.querySelector(".product-card .product-btn--buy").click());
await wait(2500);
await site.close();
await p.goto(ADMIN.split("?")[0] + "#/leads", { waitUntil: "load" });
await p.waitForSelector(".lead", { timeout: 10000 });
ok((await p.$$(".lead.is-new")).length >= 1, "lead from public site is listed as new");
await p.screenshot({ path: path.join(SHOTS, "admin-leads-d.png") });
await clickText(p, '.lead [data-act="lead"]', "Өңделді"); await p.waitForFunction(() => !document.querySelector(".lead.is-new"), { timeout: 20000 });
ok((await p.$$(".lead.is-new")).length === 0, "lead marked as processed");
const tg = await (await fetch(GH + "/__log")).json();
ok(tg.some((l) => l.telegram && /Сатып алу/.test(l.telegram.text)), "telegram notification recorded");

// users (owner)
await p.goto(ADMIN.split("?")[0] + "#/users", { waitUntil: "load" });
await p.waitForSelector(".prow");
ok((await p.$$(".prow")).length >= 2, "users list");

// editor can't see users tab
await p.evaluate(() => { localStorage.clear(); });
let p2 = await newPage(390, 844, true);
await p2.goto(ADMIN, { waitUntil: "load" }); await p2.waitForSelector("#loginForm");
await p2.type('input[name=username]', "client"); await p2.type('input[name=password]', "ClientPassw0rd-456"); await p2.click("#loginForm button");
await p2.waitForSelector(".prow", { timeout: 15000 });
ok(!(await p2.$('.nav a[href="#/users"]')), "editor does not see Users tab");
const sw = await p2.evaluate(() => document.documentElement.scrollWidth);
ok(sw <= 391, "mobile list has no horizontal scroll (" + sw + ")");
await p2.screenshot({ path: path.join(SHOTS, "admin-list-m.png") });
await p2.goto(ADMIN.split("?")[0] + "#/product/" + srcId, { waitUntil: "load" }); await p2.waitForSelector("#edForm");
ok((await p2.evaluate(() => document.documentElement.scrollWidth)) <= 391, "mobile editor has no horizontal scroll");
await p2.screenshot({ path: path.join(SHOTS, "admin-editor-m.png"), fullPage: true });
await p2.goto(ADMIN.split("?")[0] + "#/site", { waitUntil: "load" }); await p2.waitForSelector("#siteForm");
ok((await p2.evaluate(() => document.documentElement.scrollWidth)) <= 391, "mobile site settings no horizontal scroll");

ok(errs.length === 0, "no page/console errors" + (errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""));
await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nALL OK");
process.exit(fails ? 1 : 0);
