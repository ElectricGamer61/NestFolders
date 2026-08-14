"use strict";
// NestFolders test suite. Run with `npm test`.
//
// Browser extensions cannot be fully automated without a real browser, so this suite covers
// the parts that are testable off-browser: the manifest, the per-host DOM adapter, and the
// folder/layout/storage behaviour driven through the real content scripts in jsdom.
// Pointer-level drag gestures and visual polish still need the manual checklist in README.md.

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const {
    APP_DIR,
    SCRIPT_ORDER,
    manifestScriptOrder,
    loadExtension,
    settle
} = require("./harness");

const CHATGPT_CHATS = [
    { href: "/c/aaa", title: "Roadmap planning" },
    { href: "/c/bbb", title: "Bug triage" },
    { href: "/c/ccc", title: "Holiday ideas" }
];
const CLAUDE_CHATS = [
    { href: "/chat/111", title: "Sprint notes" },
    { href: "/chat/222", title: "Contract review" },
    { href: "/chat/333", title: "Recipe brainstorm" }
];

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------- manifest / packaging

test("manifest is valid, targets both hosts, and lists every content script", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(APP_DIR, "manifest.json"), "utf8"));
    assert.strictEqual(manifest.manifest_version, 3);
    assert.strictEqual(manifest.name, "NestFolders");

    const matches = manifest.content_scripts[0].matches;
    assert.deepStrictEqual(matches, ["https://chatgpt.com/*", "https://claude.ai/*"]);
    matches.forEach((pattern) => {
        assert.ok(manifest.host_permissions.includes(pattern), `missing host permission ${pattern}`);
    });

    assert.deepStrictEqual(manifestScriptOrder(), SCRIPT_ORDER,
        "test harness load order must match the manifest");
    manifestScriptOrder()
        .concat(manifest.content_scripts[0].css, Object.values(manifest.icons), manifest.action.default_popup)
        .forEach((file) => {
            assert.ok(fs.existsSync(path.join(APP_DIR, file)), `manifest references missing file ${file}`);
        });
});

test("popup host list stays in step with the manifest matches", () => {
    const popup = fs.readFileSync(path.join(APP_DIR, "popup.js"), "utf8");
    ["chatgpt.com", "claude.ai"].forEach((host) => {
        assert.ok(popup.includes(`"${host}"`), `popup.js does not recognise ${host}`);
    });
});

// ---------------------------------------------------------------- site adapter

test("site adapter resolves supported hosts only", async () => {
    const { ns, dom } = await loadExtension("chatgpt", CHATGPT_CHATS, {});
    assert.strictEqual(ns.resolveSite("chatgpt.com").key, "chatgpt");
    assert.strictEqual(ns.resolveSite("claude.ai").key, "claude");
    assert.strictEqual(ns.resolveSite("www.claude.ai").key, "claude");
    assert.strictEqual(ns.resolveSite("example.com"), null);
    assert.strictEqual(ns.resolveSite(""), null);
    dom.window.close();
});

test("ChatGPT: chat list is found and each link is its own row", async () => {
    const { ns, window, dom } = await loadExtension("chatgpt", CHATGPT_CHATS, {});
    const site = ns.site;
    assert.strictEqual(site.key, "chatgpt");
    assert.strictEqual(ns.historyDiv.id, "history");

    const rows = site.childRows(ns.historyDiv);
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(rows[0].tagName, "A");
    assert.strictEqual(site.hrefOf(rows[0]), "/c/aaa");
    assert.strictEqual(site.compactChatId("/c/aaa"), "aaa");
    assert.strictEqual(site.expandChatId("aaa"), "/c/aaa");

    const link = window.document.querySelector('a[href="/c/bbb"]');
    assert.strictEqual(site.rowFromLink(link), link);
    dom.window.close();
});

test("Claude: chat list is found structurally and the row is the list wrapper", async () => {
    const { ns, window, dom } = await loadExtension("claude", CLAUDE_CHATS, {});
    const site = ns.site;
    assert.strictEqual(site.key, "claude");
    // Detected without any id/testid on the list itself, and the empty "Starred" list is
    // not mistaken for the chat list.
    assert.ok(ns.historyDiv.classList.contains("recents"), "should anchor to the populated list");

    const rows = site.childRows(ns.historyDiv);
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(rows[0].tagName, "LI");
    assert.strictEqual(site.hrefOf(rows[0]), "/chat/111");
    assert.strictEqual(site.compactChatId("/chat/111"), "111");
    assert.strictEqual(site.expandChatId("111"), "/chat/111");

    const link = window.document.querySelector('a[href="/chat/222"]');
    assert.strictEqual(site.rowFromLink(link), link.closest("li"),
        "the whole list item must move, not just the anchor");
    dom.window.close();
});

test("Claude: the sidebar resizer is not injected into a sidebar Claude controls", async () => {
    const { window, dom } = await loadExtension("claude", CLAUDE_CHATS, {});
    assert.strictEqual(window.document.getElementById("glyn-sidebar-resizer"), null);
    dom.window.close();
});

test("chat ids round-trip, including ChatGPT's GPT-scoped conversation paths", async () => {
    const { ns, dom } = await loadExtension("chatgpt", CHATGPT_CHATS, {});
    const site = ns.site;
    ["/c/abc", "/g/g-42/c/abc"].forEach((href) => {
        assert.strictEqual(site.expandChatId(site.compactChatId(href)), href,
            `${href} should survive a compact/expand round trip`);
    });
    dom.window.close();
});

test("hrefs are normalised to a path, so absolute links map to the same chat", async () => {
    const { ns, dom } = await loadExtension("claude", CLAUDE_CHATS, {});
    assert.strictEqual(ns.site.normalizeHref("https://claude.ai/chat/111?foo=1#x"), "/chat/111");
    assert.strictEqual(ns.site.normalizeHref("/chat/111?ref=nav"), "/chat/111");
    dom.window.close();
});

// ---------------------------------------------------------------- folders end to end

const folderNames = (env) => Array.from(env.ns.folderManager.folders, (rec) => rec.folderItem.data.name);
const folderNamed = (env, name) => env.ns.folderManager.folders
    .find((rec) => rec.folderItem.data.name === name);

async function fileChatInNewFolder(env, chatHref, folderName) {
    const { ns, window } = env;
    const folder = ns.folderManager.createFolder(folderName);
    const row = ns.site.childRows(ns.historyDiv).find((el) => ns.site.hrefOf(el) === chatHref);
    assert.ok(row, `chat ${chatHref} not present in the sidebar`);
    ns.dragController.handleDrop(row.__glynChatItem, folder, folder.el);
    await ns.layoutState.save();
    await settle(window);
    return folder;
}

for (const [siteKey, chats, firstChat] of [
    ["chatgpt", CHATGPT_CHATS, "/c/bbb"],
    ["claude", CLAUDE_CHATS, "/chat/222"]
]) {
    test(`${siteKey}: a chat dropped on a folder is nested, persisted and restored`, async () => {
        const store = {};
        const env = await loadExtension(siteKey, chats, store);
        const { ns, window } = env;

        const folder = await fileChatInNewFolder(env, firstChat, "Work");
        const movedRow = folder.contentsEl.firstElementChild;
        assert.ok(movedRow, "folder should now contain the chat row");
        assert.strictEqual(ns.site.hrefOf(movedRow), firstChat);
        assert.strictEqual(ns.site.childRows(ns.historyDiv).length, chats.length - 1,
            "the chat should have left the root list");
        window.close();

        // Reload the page with the same storage: the folder and its chat come back.
        const reloaded = await loadExtension(siteKey, chats, store);
        const work = folderNamed(reloaded, "Work");
        assert.ok(work, "the folder should be restored by name");
        const restored = reloaded.ns.site.childRows(work.contentsEl);
        assert.strictEqual(restored.length, 1);
        assert.strictEqual(reloaded.ns.site.hrefOf(restored[0]), firstChat);
        reloaded.window.close();
    });

    test(`${siteKey}: folders nest inside folders and survive a reload`, async () => {
        const store = {};
        const env = await loadExtension(siteKey, chats, store);
        const { ns, window } = env;

        const parent = ns.folderManager.createFolder("Projects");
        const child = ns.folderManager.createFolder("Q3", { parentFolder: parent });
        const grandchild = ns.folderManager.createFolder("Launch", { parentFolder: child });
        const deepChat = ns.site.childRows(ns.historyDiv)[0];
        const deepHref = ns.site.hrefOf(deepChat);
        ns.dragController.handleDrop(deepChat.__glynChatItem, grandchild, grandchild.el);
        await ns.layoutState.save();
        window.close();

        const reloaded = await loadExtension(siteKey, chats, store);
        const byName = (name) => folderNamed(reloaded, name);
        assert.ok(byName("Projects") && byName("Q3") && byName("Launch"), "all three folders restored");
        assert.strictEqual(byName("Q3").folderItem.getParentFolder(), byName("Projects").folderItem);
        assert.strictEqual(byName("Launch").folderItem.getParentFolder(), byName("Q3").folderItem);
        const leaf = reloaded.ns.site.childRows(byName("Launch").contentsEl);
        assert.strictEqual(leaf.length, 1);
        assert.strictEqual(reloaded.ns.site.hrefOf(leaf[0]), deepHref);
        reloaded.window.close();
    });

    test(`${siteKey}: a chat missing from the sidebar keeps its folder and stays clickable`, async () => {
        const store = {};
        const env = await loadExtension(siteKey, chats, store);
        const filedHref = env.ns.site.hrefOf(env.ns.site.childRows(env.ns.historyDiv)[0]);
        const filedTitle = chats.find((c) => c.href === filedHref).title;
        await fileChatInNewFolder(env, filedHref, "Archive");
        env.window.close();

        // The host app no longer lists that conversation (aged out of recents / not paged in).
        const remaining = chats.filter((chat) => chat.href !== filedHref);
        const reloaded = await loadExtension(siteKey, remaining, store);
        const folder = reloaded.ns.folderManager.folders[0];
        const stub = folder.contentsEl.querySelector(".glyn-chat-stub");
        assert.ok(stub, "a stub row should stand in for the missing chat");
        assert.strictEqual(stub.querySelector("a").getAttribute("href"), filedHref);
        assert.strictEqual(stub.textContent, filedTitle, "the stored title should be shown");

        // Saving again must not drop the assignment.
        await reloaded.ns.layoutState.save();
        await settle(reloaded.window);
        reloaded.window.close();

        const rehydrated = await loadExtension(siteKey, chats, store);
        const rows = rehydrated.ns.site.childRows(rehydrated.ns.folderManager.folders[0].contentsEl);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rehydrated.ns.site.hrefOf(rows[0]), filedHref);
        assert.strictEqual(rows[0].querySelector(".glyn-chat-stub-link"), null,
            "the live row should replace the stub once the app lists it again");
        rehydrated.window.close();
    });

    test(`${siteKey}: chats added to the sidebar later become draggable`, async () => {
        const env = await loadExtension(siteKey, chats, {});
        const { ns, window } = env;
        const before = ns.site.childRows(ns.historyDiv).length;

        const template = ns.site.childRows(ns.historyDiv)[0].cloneNode(true);
        const link = ns.site.linkFromRow(template);
        link.setAttribute("href", siteKey === "claude" ? "/chat/999" : "/c/999");
        link.textContent = "Loaded on scroll";
        ns.historyDiv.appendChild(template);
        await settle(window);

        const rows = ns.site.childRows(ns.historyDiv);
        assert.strictEqual(rows.length, before + 1);
        const added = rows[rows.length - 1];
        assert.ok(added.__glynChatItem, "the newly rendered chat should be wired for drag");
        assert.ok(added.getAttribute("draggable"), "the newly rendered chat should be draggable");
        window.close();
    });
}

test("folders stay pinned above chats without fighting the user's ordering", async () => {
    const { ns, window, dom } = await loadExtension("chatgpt", CHATGPT_CHATS, {});
    const first = ns.folderManager.createFolder("Alpha");
    const second = ns.folderManager.createFolder("Beta");
    ns.folderManager.pinFoldersAtTop();

    const children = Array.from(ns.historyDiv.children);
    const folderCount = ns.folderManager.folders.length;
    children.slice(0, folderCount).forEach((child, i) => {
        assert.ok(child.classList.contains("glyn-folder-wrapper"), `child ${i} should be a folder`);
    });
    assert.ok(children.slice(folderCount).every((child) => ns.site.isChatRow(child)),
        "chats follow the folders");

    // Reordering the folders must survive the next pin pass, which runs after every change.
    const firstWrapper = ns.folderManager.getRecordByFolderItem(first).wrapperEl;
    const secondWrapper = ns.folderManager.getRecordByFolderItem(second).wrapperEl;
    ns.historyDiv.insertBefore(secondWrapper, firstWrapper);
    ns.folderManager.pinFoldersAtTop();
    await settle(window);
    assert.strictEqual(ns.historyDiv.children[0], secondWrapper, "user ordering must be preserved");
    dom.window.close();
});

test("deleting a folder returns its chats to the root list", async () => {
    const store = {};
    const env = await loadExtension("claude", CLAUDE_CHATS, store);
    const { ns, window } = env;
    const folder = await fileChatInNewFolder(env, "/chat/222", "Temp");
    assert.strictEqual(ns.site.childRows(ns.historyDiv).length, 2);

    const before = ns.folderManager.folders.length;
    await ns.folderManager.deleteFolder(folder.folderItem || folder, { skipConfirm: true });
    await settle(window);

    assert.strictEqual(ns.folderManager.folders.length, before - 1);
    assert.strictEqual(folderNamed({ ns }, "Temp"), undefined, "the folder is gone");
    const rootHrefs = ns.site.childRows(ns.historyDiv).map((row) => ns.site.hrefOf(row));
    assert.ok(rootHrefs.includes("/chat/222"), "the chat should be back at the root");
    window.close();
});

// ---------------------------------------------------------------- storage separation

test("ChatGPT and Claude layouts share one storage area without colliding", async () => {
    const store = {};

    const gpt = await loadExtension("chatgpt", CHATGPT_CHATS, store);
    await fileChatInNewFolder(gpt, "/c/aaa", "GPT work");
    gpt.window.close();

    const claude = await loadExtension("claude", CLAUDE_CHATS, store);
    await fileChatInNewFolder(claude, "/chat/111", "Claude work");
    claude.window.close();

    const keys = Object.keys(store).sort();
    assert.ok(keys.some((key) => key.startsWith("cl:")), "Claude keys should be namespaced");
    assert.ok(keys.some((key) => /^f\d/.test(key)), "ChatGPT keys stay unprefixed for upgrades");

    // Each app reloads its own folders and only its own folders.
    const gptAgain = await loadExtension("chatgpt", CHATGPT_CHATS, store);
    const gptNames = folderNames(gptAgain);
    assert.ok(gptNames.includes("GPT work"), "ChatGPT keeps its own folder");
    assert.ok(!gptNames.includes("Claude work"), "ChatGPT must not see Claude folders");
    gptAgain.window.close();

    const claudeAgain = await loadExtension("claude", CLAUDE_CHATS, store);
    const claudeNames = folderNames(claudeAgain);
    assert.ok(claudeNames.includes("Claude work"), "Claude keeps its own folder");
    assert.ok(!claudeNames.includes("GPT work"), "Claude must not see ChatGPT folders");
    claudeAgain.window.close();
});

test("an export snapshot carries both apps and can be re-imported", async () => {
    const store = {};
    const gpt = await loadExtension("chatgpt", CHATGPT_CHATS, store);
    await fileChatInNewFolder(gpt, "/c/aaa", "GPT work");
    gpt.window.close();
    const claude = await loadExtension("claude", CLAUDE_CHATS, store);
    await fileChatInNewFolder(claude, "/chat/111", "Claude work");
    claude.window.close();

    const backup = JSON.parse(JSON.stringify(store));
    Object.keys(store).forEach((key) => delete store[key]);
    const wiped = await loadExtension("claude", CLAUDE_CHATS, store);
    assert.deepStrictEqual(folderNames(wiped), ["New Folder"],
        "a cleared profile starts from the default folder");
    wiped.window.close();

    Object.assign(store, backup);
    const restored = await loadExtension("claude", CLAUDE_CHATS, store);
    assert.ok(folderNames(restored).includes("Claude work"));
    restored.window.close();
});

test("only folder structure, chat paths and titles are written to storage", async () => {
    const store = {};
    const env = await loadExtension("claude", CLAUDE_CHATS, store);
    await fileChatInNewFolder(env, "/chat/111", "Work");
    env.window.close();

    const serialised = JSON.stringify(store);
    assert.ok(serialised.includes("111"), "chat id is stored");
    assert.ok(!serialised.includes("claude.ai"), "no absolute URLs are stored");
    const values = JSON.parse(serialised);
    Object.keys(values).forEach((key) => {
        assert.ok(/^(cl:)?(f\d+|settings)/.test(key), `unexpected storage key ${key}`);
    });
});

// ---------------------------------------------------------------- runner

(async () => {
    let failed = 0;
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log(`  ok  ${name}`);
        } catch (err) {
            failed += 1;
            console.log(`FAIL  ${name}`);
            console.log(String(err && err.stack ? err.stack : err).split("\n").map((l) => `      ${l}`).join("\n"));
        }
    }
    console.log(`\n${tests.length - failed}/${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
