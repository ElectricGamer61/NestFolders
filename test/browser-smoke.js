"use strict";
/*
 * Real-browser smoke test.
 *
 * jsdom proves the folder logic; this proves the packaging: that Chromium loads the unpacked
 * extension, that the manifest's claude.ai match actually injects the content scripts, and
 * that folder UI appears in a real layout engine. The page is a stand-in for Claude's sidebar
 * served from the claude.ai origin through CDP request interception, so no account is needed.
 *
 * It cannot validate Claude's real markup - only a signed-in human can. See the manual
 * checklist in README.md.
 *
 *   node test/browser-smoke.js [--chrome /path/to/chrome] [--screenshot out.png]
 */

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_DIR = path.join(__dirname, "..", "App");

const CLAUDE_FIXTURE = `<!doctype html>
<html><head><title>Claude</title><style>
  body { margin:0; background:#faf9f5; color:#1f1e1d; font-family:system-ui, sans-serif; }
  [data-testid="menu-sidebar"] { width:280px; padding:12px; }
  ul { list-style:none; margin:0; padding:0; }
  li a { display:block; padding:6px 10px; color:inherit; text-decoration:none; }
</style></head>
<body>
  <div data-testid="menu-sidebar">
    <div class="heading">Recents</div>
    <ul class="recents">
      <li><a href="/chat/11111111-1111-1111-1111-111111111111">Sprint notes</a><button>...</button></li>
      <li><a href="/chat/22222222-2222-2222-2222-222222222222">Contract review</a><button>...</button></li>
      <li><a href="/chat/33333333-3333-3333-3333-333333333333">Recipe brainstorm</a><button>...</button></li>
    </ul>
  </div>
</body></html>`;

function findChrome() {
    const flagIndex = process.argv.indexOf("--chrome");
    if (flagIndex !== -1 && process.argv[flagIndex + 1]) return process.argv[flagIndex + 1];
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
    for (const candidate of ["google-chrome", "chromium", "chromium-browser"]) {
        try {
            return execSync(`command -v ${candidate}`, { encoding: "utf8" }).trim();
        } catch (_err) { /* keep looking */ }
    }
    const cache = path.join(os.homedir(), ".cache", "puppeteer", "chrome");
    if (fs.existsSync(cache)) {
        const builds = fs.readdirSync(cache).sort().reverse();
        for (const build of builds) {
            const bin = path.join(cache, build, "chrome-linux64", "chrome");
            if (fs.existsSync(bin)) return bin;
        }
    }
    return null;
}

class CDP {
    constructor(url) {
        this.socket = new WebSocket(url);
        this.nextId = 1;
        this.pending = new Map();
        this.handlers = [];
        this.ready = new Promise((resolve, reject) => {
            this.socket.addEventListener("open", resolve);
            this.socket.addEventListener("error", reject);
        });
        this.socket.addEventListener("message", (event) => {
            const message = JSON.parse(event.data);
            if (message.id && this.pending.has(message.id)) {
                const { resolve, reject } = this.pending.get(message.id);
                this.pending.delete(message.id);
                message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
                return;
            }
            this.handlers.forEach((handler) => handler(message));
        });
    }

    on(handler) { this.handlers.push(handler); }

    send(method, params, sessionId) {
        const id = this.nextId++;
        const payload = { id, method, params: params || {} };
        if (sessionId) payload.sessionId = sessionId;
        this.socket.send(JSON.stringify(payload));
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }

    close() { this.socket.close(); }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    const chrome = findChrome();
    if (!chrome) {
        console.log("SKIP: no Chrome/Chromium binary found (pass --chrome <path> or set CHROME_PATH)");
        process.exit(0);
    }

    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nestfolders-smoke-"));
    const child = spawn(chrome, [
        "--headless=new",
        "--no-sandbox",
        "--no-first-run",
        "--disable-gpu",
        `--user-data-dir=${profile}`,
        `--load-extension=${APP_DIR}`,
        `--disable-extensions-except=${APP_DIR}`,
        "--remote-debugging-port=0",
        "about:blank"
    ], { stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    const portFile = path.join(profile, "DevToolsActivePort");
    let endpoint = null;
    for (let i = 0; i < 100 && !endpoint; i += 1) {
        await wait(100);
        if (fs.existsSync(portFile)) {
            const [port, route] = fs.readFileSync(portFile, "utf8").trim().split("\n");
            endpoint = `ws://127.0.0.1:${port}${route}`;
        }
    }
    if (!endpoint) throw new Error(`Chrome did not expose a DevTools endpoint.\n${stderr}`);

    const client = new CDP(endpoint);
    await client.ready;

    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });

    // Serve the fixture for any claude.ai request so the content script matches for real.
    await client.send("Fetch.enable", {
        patterns: [{ urlPattern: "https://claude.ai/*", requestStage: "Request" }]
    }, sessionId);
    client.on((message) => {
        if (message.method !== "Fetch.requestPaused") return;
        client.send("Fetch.fulfillRequest", {
            requestId: message.params.requestId,
            responseCode: 200,
            responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
            body: Buffer.from(CLAUDE_FIXTURE).toString("base64")
        }, message.sessionId).catch(() => {});
    });

    await client.send("Page.enable", {}, sessionId);
    await client.send("Page.navigate", { url: "https://claude.ai/new" }, sessionId);
    await wait(4000);

    const probe = `(() => {
        const wrappers = document.querySelectorAll(".glyn-folder-wrapper");
        const row = document.querySelector(".glyn-folder-row");
        const list = document.querySelector("ul.recents");
        const rowStyle = row ? getComputedStyle(row) : null;
        // Content scripts run in an isolated world, so their globals are deliberately not
        // reachable from here: everything below is observed through the page's own DOM.
        return JSON.stringify({
            folderCount: wrappers.length,
            folderLabel: row ? row.innerText.trim() : null,
            folderIsFirstInList: !!(list && list.firstElementChild &&
                list.firstElementChild.classList.contains("glyn-folder-wrapper")),
            chatRowsBelow: list ? list.querySelectorAll('li a[href^="/chat/"]').length : 0,
            themeClass: document.documentElement.className,
            rowVisible: !!(row && row.getBoundingClientRect().width > 50 &&
                rowStyle.display !== "none" && rowStyle.visibility !== "hidden"),
            folderIconRendered: !!document.querySelector(".glyn-folder-icon svg")
        });
    })()`;
    const { result } = await client.send("Runtime.evaluate", { expression: probe }, sessionId);
    const report = JSON.parse(result.value);
    console.log(JSON.stringify(report, null, 2));

    const shotIndex = process.argv.indexOf("--screenshot");
    if (shotIndex !== -1 && process.argv[shotIndex + 1]) {
        const shot = await client.send("Page.captureScreenshot", { format: "png" }, sessionId);
        fs.writeFileSync(process.argv[shotIndex + 1], Buffer.from(shot.data, "base64"));
        console.log(`screenshot written to ${process.argv[shotIndex + 1]}`);
    }

    client.close();
    child.kill();
    fs.rmSync(profile, { recursive: true, force: true });

    const failures = [];
    if (report.folderCount < 1) failures.push("content scripts did not render folder UI on claude.ai");
    if (!/glyn-site-claude/.test(report.themeClass)) failures.push("the Claude site adapter did not activate");
    if (!report.folderIsFirstInList) failures.push("folders are not pinned above the chat list");
    if (report.chatRowsBelow !== 3) failures.push("chat rows were disturbed");
    if (!report.rowVisible) failures.push("the folder row is not visible");
    if (!report.folderIconRendered) failures.push("the folder icon did not render");
    if (!/glyn-theme-light/.test(report.themeClass)) {
        failures.push("light sidebar was not detected as a light theme");
    }

    if (failures.length) {
        failures.forEach((failure) => console.log(`FAIL  ${failure}`));
        process.exit(1);
    }
    console.log("\nok  extension loads in Chromium and renders folder UI on claude.ai");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
