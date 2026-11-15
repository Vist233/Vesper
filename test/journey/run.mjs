// The journey test: the whole box without a model. Runs INSIDE a running box (`npm run journey` does the docker exec):
// the real gateway, desk-daemon, Xvfb, Chromium, x11vnc and noVNC. A person opens the page, watches the agent's browser,
// takes over, types a password with symbols and Chinese text into a fixture page, hands back, and the journal says the
// take-over was really viewed. Uses the image's Playwright (global) and its Chromium. Prints one line per step; exits 1
// on the first failure. Leaves no session behind.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("/usr/local/lib/node_modules/playwright/");
const { chromium } = require("playwright");

const BASE = "http://127.0.0.1:8787";
const FIXTURE_PORT = 8011;
const PASSWORD = "ogb-journey-1!@#";
const CHINESE = "你好世界";

const step = (text) => console.log(`ok   ${text}`);
const fail = (text) => {
  console.log(`FAIL ${text}`);
  process.exitCode = 1;
  throw new Error(text);
};
const api = async (method, path, body) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) fail(`${method} ${path} answered ${response.status}`);
  return response.status === 204 ? null : response.json();
};
const until = async (what, check, ms = 15_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) fail(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

/** One DevTools call on a page target of the workspace's Chromium. */
async function devtools(port, match, expression) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((t) => t.type === "page" && match(t.url));
  if (!target) return undefined;
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const answer = await new Promise((resolve) => {
    socket.onmessage = (event) => resolve(JSON.parse(event.data));
    socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  socket.close();
  return answer.result?.result?.value;
}

const dir = "/tmp/ogb-journey";
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/login.html`, `<!doctype html><meta charset="utf-8"><title>Journey login</title><input id="p" type="password" autofocus><input id="n">`);
const fixture = spawn("python3", ["-m", "http.server", String(FIXTURE_PORT), "--bind", "127.0.0.1", "--directory", dir], { stdio: "ignore" });
const browser = await chromium.launch({ headless: true });
let sessionId;
try {
  const created = await api("POST", "/api/sessions", { title: "journey" });
  sessionId = created.session.id;
  step(`session ${sessionId} created`);
  const record = await until("the workspace's DevTools port", async () => {
    const out = await new Promise((resolve) => {
      const ps = spawn("ps", ["-eo", "args"]);
      let text = "";
      ps.stdout.on("data", (chunk) => (text += chunk));
      ps.on("close", () => resolve(text));
    });
    const workspace = sessionId.replace("_", "-");
    const line = out.split("\n").find((l) => l.includes(`/workspaces/${workspace}/profile`) && l.includes("remote-debugging-port="));
    return line?.match(/remote-debugging-port=(\d+)/)?.[1];
  });
  const cdp = Number(record);
  step(`workspace browser on DevTools port ${cdp}`);
  await fetch(`http://127.0.0.1:${cdp}/json/new?http://127.0.0.1:${FIXTURE_PORT}/login.html`, { method: "PUT" });
  await until("the fixture page in the workspace", () => devtools(cdp, (u) => u.includes("login.html"), "document.title"));
  step("the agent's browser shows the fixture page");

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${BASE}/#/s/${sessionId}`);
  await page.locator("#desk-pill").click();
  await until("watching", async () => page.locator("#desk-takeover").isVisible());
  const colours = await until("a picture with more than one colour", () =>
    page.evaluate(() => {
      const canvas = document.querySelector("#desk-screen canvas");
      if (!canvas || canvas.width === 0) return 0;
      const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      const seen = new Set();
      for (let i = 0; i < data.length; i += 4000) seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      return seen.size > 3 ? seen.size : 0;
    }),
  );
  step(`live view shows the desktop (${colours} colours sampled)`);

  await page.getByRole("button", { name: "Take over" }).click();
  await until("control", async () => (await page.locator("#desk-mode").innerText()) === "You have control");
  step("take-over: the person has control");
  await devtools(cdp, (u) => u.includes("login.html"), "document.getElementById('p').focus(), true");
  await page.getByRole("button", { name: "Send text" }).click();
  const field = page.getByLabel("Text to type into the desktop");
  await field.fill(PASSWORD);
  await field.press("Enter");
  await until(
    "the password in the remote field",
    async () => (await devtools(cdp, (u) => u.includes("login.html"), "document.getElementById('p').value")) === PASSWORD,
  );
  step("a password with symbols arrived key by key");
  await devtools(cdp, (u) => u.includes("login.html"), "document.getElementById('n').focus(), true");
  await field.fill(CHINESE);
  await field.press("Enter");
  await until(
    "the Chinese text in the remote field",
    async () => (await devtools(cdp, (u) => u.includes("login.html"), "document.getElementById('n').value")) === CHINESE,
  );
  step("Chinese text arrived through the page-input route");

  await page.getByLabel(/What did you do/).fill("journey done");
  await page.locator("#handback-bar").getByRole("button", { name: "Hand back" }).click();
  await until("watching again", async () => page.locator("#desk-takeover").isVisible());
  const history = await api("GET", `/api/sessions/${sessionId}/history`);
  const closed = history.events.find((e) => e.type === "takeover.closed");
  if (!closed?.payload?.viewed) fail(`the journal has no viewed take-over: ${JSON.stringify(closed?.payload)}`);
  if (JSON.stringify(history.events).includes(PASSWORD)) fail("the password reached the journal");
  step("hand-back: the journal says the take-over was viewed, and the password is nowhere in it");
  console.log("journey passed");
} finally {
  await browser.close().catch(() => {});
  fixture.kill();
  if (sessionId) await fetch(`${BASE}/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
}
