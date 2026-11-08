#!/usr/bin/env node
// Captures showcase screenshots from a running omp-web that serves the demo
// HOME created by scripts/site/demo-data.mjs. See site/README.md.
//
// Env: BASE_URL, DEMO_USER, DEMO_PASSWORD, PLAYWRIGHT_CORE (module path),
//      CHROME (browser executable), OUT (output dir, default site/assets/shots),
//      THEME (dark | light | starfield, default dark)
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const base = process.env.BASE_URL || "http://127.0.0.1:30199";
const out = process.env.OUT || join(import.meta.dirname, "../../site/assets/shots");
const theme = process.env.THEME || "dark";
const only = process.env.ONLY?.split(",");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });

async function open(viewport, mobile = false) {
  const context = await browser.newContext({
    viewport, deviceScaleFactor: mobile ? 3 : 2, isMobile: mobile, hasTouch: mobile,
    colorScheme: theme === "light" ? "light" : "dark", locale: "en-US", timezoneId: "Europe/Paris",
  });
  await context.addInitScript((t) => {
    localStorage.setItem("omp-theme", t);
    localStorage.setItem("pi-locale", "en");
    // The demo HOME has no OMP/Pi model login; keep idle pages on Claude Code.
    localStorage.setItem("omp-web:new-chat-engine", "claude");
  }, theme);
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("pageerror:", error.message));
  await page.goto(`${base}/login`);
  await page.fill('input[name="username"]', process.env.DEMO_USER || "demo");
  await page.fill('input[name="password"]', process.env.DEMO_PASSWORD || "");
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
  await page.waitForTimeout(1200);
  return { context, page };
}

async function openSession(page, title) {
  await page.getByText(title, { exact: true }).first().click();
  await page.waitForTimeout(2200);
  await page.mouse.move(900, 600);
}

async function shot(page, name) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`saved ${name}.png`);
}

const want = (name) => !only || only.includes(name);
const desktop = { width: 1440, height: 900 };

if (want("chat")) {
  const { context, page } = await open(desktop);
  await openSession(page, "Cache tide charts for offline use");
  await page.getByText(/Process details/).first().click();
  await page.waitForTimeout(600);
  // Second occurrence of the path is the Edit tool call (the first is Read).
  await page.getByText("/home/demo/code/tidewater/src/sw.js", { exact: true }).nth(1).click();
  await page.waitForTimeout(800);
  await page.mouse.move(1300, 120);
  await shot(page, "chat");
  await context.close();
}

if (want("files")) {
  const { context, page } = await open(desktop);
  await openSession(page, "Cache tide charts for offline use");
  await page.getByText("src", { exact: true }).first().click();
  await page.waitForTimeout(700);
  await page.getByText("sw.js", { exact: true }).first().click();
  await page.waitForTimeout(1800);
  await page.getByRole("button", { name: "Diff", exact: true }).first().click();
  await page.waitForTimeout(1200);
  await page.mouse.move(700, 800);
  await shot(page, "files");
  await context.close();
}

if (want("terminal")) {
  const { context, page } = await open(desktop);
  await openSession(page, "Cache tide charts for offline use");
  await page.getByTitle("Show/hide terminal (shell keeps running)").first().click();
  await page.waitForTimeout(2500);
  await page.keyboard.type("git status -sb && git diff --stat\n", { delay: 15 });
  await page.waitForTimeout(800);
  await page.keyboard.type("git log --oneline -3\n", { delay: 15 });
  await page.waitForTimeout(1200);
  await shot(page, "terminal");
  await context.close();
}

const phone = { width: 390, height: 844 };

async function sessionUrl(page, title) {
  const { sessions } = await page.evaluate(() => fetch("/api/sessions").then((r) => r.json()));
  const match = sessions.find((s) => s.name === title);
  if (!match) throw new Error(`No demo session titled ${title}`);
  return `${base}/?session=${encodeURIComponent(match.id)}`;
}

if (want("mobile")) {
  const { context, page } = await open(phone, true);
  await page.goto(await sessionUrl(page, "Cache tide charts for offline use"));
  await page.waitForTimeout(2500);
  await shot(page, "mobile-chat");
  await page.getByRole("button", { name: "Show sidebar", exact: true }).first().click();
  await page.waitForTimeout(1200);
  await shot(page, "mobile-sessions");
  await context.close();
}

await browser.close();
