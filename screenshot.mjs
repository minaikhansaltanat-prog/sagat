import puppeteer from "puppeteer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "temporary screenshots");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

function nextIndex() {
  const files = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
  const nums = files
    .map((f) => f.match(/^screenshot-(\d+)/))
    .filter(Boolean)
    .map((m) => parseInt(m[1], 10));
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

const url = process.argv[2] || "http://localhost:3000";
const label = process.argv[3] || "";
const widthArg = process.argv[4] ? parseInt(process.argv[4], 10) : 1440;
const heightArg = process.argv[5] ? parseInt(process.argv[5], 10) : 900;
const fullPage = process.argv.includes("--full");

const browser = await puppeteer.launch({ headless: "new" });
const page = await browser.newPage();
await page.setViewport({ width: widthArg, height: heightArg, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });

if (fullPage) {
  // Trigger native lazy-loaded images by scrolling through the whole page first.
  const total = await page.evaluate(() => document.body.scrollHeight);
  const step = Math.max(200, heightArg);
  for (let y = 0; y < total; y += step) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await new Promise((r) => setTimeout(r, 120));
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((r) => setTimeout(r, 1500));
}

await new Promise((r) => setTimeout(r, 400));

const idx = nextIndex();
const suffix = label ? `-${label}` : "";
const filePath = path.join(outDir, `screenshot-${idx}${suffix}.png`);
await page.screenshot({ path: filePath, fullPage });

console.log("Saved:", filePath);
await browser.close();
