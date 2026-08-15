"use strict";
/*
 * Shared plumbing for the real-browser tests: find a Chromium, launch it with the unpacked
 * extension loaded, and talk CDP to it. Neither test needs an account: each serves its own
 * fixture from the host's origin through CDP request interception, so the content script
 * matches and injects exactly as it would on the live site.
 */

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_DIR = path.join(__dirname, "..", "App");

function findChrome(argv = process.argv) {
    const flagIndex = argv.indexOf("--chrome");
    if (flagIndex !== -1 && argv[flagIndex + 1]) return argv[flagIndex + 1];
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

/** Launch headless Chromium with the extension loaded and return a connected CDP client. */
async function launch() {
    const chrome = findChrome();
    if (!chrome) return null;

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

    return {
        client,
        sessionId,
        /** Serve `html` for every request matching `urlPattern`, whatever the real site would do. */
        async serve(urlPattern, html) {
            await client.send("Fetch.enable", {
                patterns: [{ urlPattern, requestStage: "Request" }]
            }, sessionId);
            client.on((message) => {
                if (message.method !== "Fetch.requestPaused") return;
                client.send("Fetch.fulfillRequest", {
                    requestId: message.params.requestId,
                    responseCode: 200,
                    responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
                    body: Buffer.from(html).toString("base64")
                }, message.sessionId).catch(() => {});
            });
        },
        async evaluate(expression) {
            const { result } = await client.send("Runtime.evaluate", {
                expression,
                awaitPromise: true,
                returnByValue: true
            }, sessionId);
            return result.value;
        },
        /** `clip` is in CSS pixels of the emulated viewport; omit it to capture the whole page. */
        async screenshot(file, { width, height, mobile = false, clip } = {}) {
            if (width && height) {
                await client.send("Emulation.setDeviceMetricsOverride", {
                    width, height, deviceScaleFactor: 2, mobile
                }, sessionId);
                await wait(400);
            }
            const params = { format: "png" };
            if (clip) {
                params.clip = Object.assign({ x: 0, y: 0, scale: 2 }, clip);
            }
            const shot = await client.send("Page.captureScreenshot", params, sessionId);
            fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
        },
        close() {
            client.close();
            child.kill();
            fs.rmSync(profile, { recursive: true, force: true });
        }
    };
}

module.exports = { APP_DIR, CDP, findChrome, launch, wait };
