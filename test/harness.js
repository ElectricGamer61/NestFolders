"use strict";
// Boots the real content scripts inside a jsdom page whose sidebar markup mimics a host app,
// with an in-memory chrome.storage. Everything the tests assert on is the extension's own
// behaviour - no logic is reimplemented here.

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const APP_DIR = path.join(__dirname, "..", "App");

// Same order as manifest.json content_scripts.js.
const SCRIPT_ORDER = [
    "siteAdapter.js",
    "draggableElement.js",
    "chatItem.js",
    "icons.js",
    "folderItem.js",
    "historyManager.js",
    "folderMenu.js",
    "folderManager.js",
    "storageService.js",
    "globalSettings.js",
    "layoutState.js",
    "dragController.js",
    "main.js"
];

function manifestScriptOrder() {
    const manifest = JSON.parse(fs.readFileSync(path.join(APP_DIR, "manifest.json"), "utf8"));
    return manifest.content_scripts[0].js;
}

/**
 * The ChatGPT layout the extension was originally written against: each conversation is a
 * top-level <a class="__menu-item"> directly inside #history. Kept as a fixture because users
 * on that build must keep working.
 */
function chatgptSidebar(chats) {
    const items = chats
        .map((chat) => `<a class="__menu-item" href="${chat.href}">${chat.title}</a>`)
        .join("");
    return `<nav aria-label="Chat history"><div id="history">${items}</div></nav>`;
}

/**
 * Current ChatGPT markup, transcribed from a signed-in sidebar capture: rows are wrapped in
 * `#history > ul > li`, and each project is an expando whose body holds that project's own
 * chat list. A project chat's href carries the project id (`/g/g-p-<id>/c/<uuid>`) while the
 * project's own sidebar link carries id *and* slug (`/g/g-p-<id>-<slug>/project`).
 */
function chatgptRow(chat, extraClass = "") {
    return `<li class="list-none"><a class="group __menu-item hoverable${extraClass}"` +
        ` data-sidebar-item="true" href="${chat.href}">` +
        `<div class="flex min-w-0 grow items-center"><div class="truncate">` +
        `<span dir="auto">${chat.title}</span></div></div>` +
        `<div class="trailing"><button data-conversation-options-trigger="x">...</button></div>` +
        `</a></li>`;
}

function chatgptModernSidebar(chats, options) {
    const projects = (options && options.projects) || [];
    const projectSections = projects.map((project, index) => {
        const rows = project.chats.map((chat) => chatgptRow(chat, " ps-9")).join("");
        return `<li class="list-none">` +
            `<a class="group __menu-item hoverable" data-sidebar-item="true"` +
            ` href="/g/${project.id}-${project.slug}/project">${project.name}</a>` +
            `<div id="_r_${index}_" class="overflow-hidden">` +
            `<ul class="m-0 list-none p-0">${rows}</ul></div></li>`;
    }).join("");

    const history = chats.map((chat) => chatgptRow(chat)).join("");
    return `<nav aria-label="Chat history">
        ${projects.length
            ? `<div class="sidebar-expando-section"><ul class="m-0 list-none p-0">${projectSections}</ul></div>`
            : ""}
        <div id="history"><ul class="m-0 list-none p-0">${history}</ul></div>
      </nav>`;
}

/**
 * Claude wraps each conversation in list markup and exposes no stable ids on the list itself,
 * which is exactly the case the structural container detection has to handle. The extra
 * "Starred" group and the trailing button inside each row are there to keep the fixture
 * honest about that shape.
 */
function claudeSidebar(chats) {
    const items = chats
        .map((chat) => `<li class="c-row"><a href="${chat.href}"><span>${chat.title}</span></a><button>...</button></li>`)
        .join("");
    return `
      <div data-testid="menu-sidebar">
        <div class="section"><div class="heading">Starred</div><ul class="starred"></ul></div>
        <div class="section"><div class="heading">Recents</div><ul class="recents">${items}</ul></div>
      </div>`;
}

const FIXTURES = {
    chatgpt: { url: "https://chatgpt.com/", body: chatgptSidebar },
    "chatgpt-modern": { url: "https://chatgpt.com/", body: chatgptModernSidebar },
    claude: { url: "https://claude.ai/new", body: claudeSidebar }
};

function createChromeStub(store) {
    const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
    const area = {
        get(keys, callback) {
            const result = {};
            if (keys === null || keys === undefined) {
                Object.keys(store).forEach((key) => { result[key] = clone(store[key]); });
            } else if (Array.isArray(keys)) {
                keys.forEach((key) => {
                    if (key in store) result[key] = clone(store[key]);
                });
            } else if (typeof keys === "object") {
                Object.keys(keys).forEach((key) => {
                    result[key] = key in store ? clone(store[key]) : clone(keys[key]);
                });
            } else if (keys in store) {
                result[keys] = clone(store[keys]);
            }
            setTimeout(() => callback(result), 0);
        },
        set(items, callback) {
            Object.keys(items || {}).forEach((key) => { store[key] = clone(items[key]); });
            setTimeout(() => callback && callback(), 0);
        },
        remove(keys, callback) {
            (Array.isArray(keys) ? keys : [keys]).forEach((key) => { delete store[key]; });
            setTimeout(() => callback && callback(), 0);
        }
    };
    return {
        storage: { sync: area, local: area },
        runtime: { onMessage: { addListener() {} }, lastError: null }
    };
}

/**
 * Load the extension into a fresh page.
 *
 * @param {"chatgpt"|"chatgpt-modern"|"claude"} siteKey
 * @param {Array<{href: string, title: string}>} chats
 * @param {object} store shared chrome.storage.sync contents (mutated in place)
 * @param {object} [options] `projects` for the fixture, `url` to override the page address
 *                           (which is how the extension knows which project you are viewing)
 */
async function loadExtension(siteKey, chats, store, options) {
    const fixture = FIXTURES[siteKey];
    const opts = options || {};
    const dom = new JSDOM(`<!doctype html><html><body>${fixture.body(chats, opts)}</body></html>`, {
        url: opts.url || fixture.url,
        pretendToBeVisual: true,
        // Gives window.eval a real window scope; we inject the content scripts ourselves
        // rather than letting the page run any script of its own.
        runScripts: "outside-only"
    });
    const { window } = dom;
    window.chrome = createChromeStub(store);
    // Only surface real problems; the extension logs a ready line on every boot.
    const quiet = () => {};
    window.console.info = quiet;
    window.console.debug = quiet;
    window.console.log = quiet;

    for (const file of SCRIPT_ORDER) {
        window.eval(fs.readFileSync(path.join(APP_DIR, file), "utf8"));
    }

    await settle(window, 12);
    return { dom, window, ns: window.GlynGPT };
}

/**
 * Let queued timers, microtasks and animation frames drain. Each tick is longer than one
 * jsdom animation frame so that work the extension defers to requestAnimationFrame - the
 * coalesced sidebar rescan - actually runs.
 */
function settle(window, ticks = 6, delayMs = 20) {
    return new Promise((resolve) => {
        let remaining = ticks;
        const step = () => {
            if (remaining-- <= 0) {
                resolve();
                return;
            }
            window.setTimeout(step, delayMs);
        };
        step();
    });
}

module.exports = {
    APP_DIR,
    SCRIPT_ORDER,
    manifestScriptOrder,
    loadExtension,
    settle,
    createChromeStub
};
