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

// ---------------------------------------------------------------- current ChatGPT markup

// Transcribed from a signed-in ChatGPT sidebar: rows live in `#history > ul > li`, projects are
// expandos, and a project's chats carry the project id in their own href.
const PROJECT_ID = "g-p-68ee40f272548191b206b8f939a83182";
const OTHER_PROJECT_ID = "g-p-6a1eaf720f50819183099558b0906b93";
const ROBLOX = {
    id: PROJECT_ID,
    slug: "roblox-dev",
    name: "Roblox dev",
    chats: [
        { href: `/g/${PROJECT_ID}/c/p-111`, title: "Datastore design" },
        { href: `/g/${PROJECT_ID}/c/p-222`, title: "NPC pathfinding" },
        { href: `/g/${PROJECT_ID}/c/p-333`, title: "Rojo setup" }
    ]
};
const FINANCE = {
    id: OTHER_PROJECT_ID,
    slug: "finanse",
    name: "Finance",
    chats: [{ href: `/g/${OTHER_PROJECT_ID}/c/q-111`, title: "Budget model" }]
};
const projectUrl = (project) => `https://chatgpt.com/g/${project.id}-${project.slug}/project`;
const projectScope = (env, projectId) =>
    env.ns.scopes.find((scope) => scope.projectId === projectId) || null;

test("ChatGPT: the row is the list item, not the list that holds it", async () => {
    const { ns, window, dom } = await loadExtension("chatgpt-modern", CHATGPT_CHATS, {});
    const site = ns.site;
    // #history says where the list is; the element whose children are rows is the <ul> inside.
    assert.strictEqual(ns.historyDiv.tagName, "UL");
    assert.strictEqual(ns.historyDiv.parentElement.id, "history");

    const rows = site.childRows(ns.historyDiv);
    assert.strictEqual(rows.length, 3, "one row per conversation, not one row for the whole list");
    assert.strictEqual(rows[0].tagName, "LI");
    assert.strictEqual(site.hrefOf(rows[0]), "/c/aaa");

    const link = window.document.querySelector('a[href="/c/bbb"]');
    assert.strictEqual(site.rowFromLink(link), link.closest("li"));
    dom.window.close();
});

test("a chat list holding a single conversation still resolves to the list", async () => {
    const { ns, dom } = await loadExtension("chatgpt-modern", [CHATGPT_CHATS[0]], {});
    assert.strictEqual(ns.historyDiv.tagName, "UL");
    assert.strictEqual(ns.site.childRows(ns.historyDiv).length, 1);
    dom.window.close();
});

test("ChatGPT: each project's chat list gets its own folder tree", async () => {
    const env = await loadExtension("chatgpt-modern", CHATGPT_CHATS, {}, {
        projects: [ROBLOX, FINANCE],
        url: projectUrl(ROBLOX)
    });
    const { ns, window } = env;

    assert.ok(ns.site.supportsProjectFolders(), "ChatGPT supports project folders");
    assert.strictEqual(ns.site.currentProjectId(), PROJECT_ID,
        "the project id is read from the URL with the slug stripped");

    const roblox = projectScope(env, PROJECT_ID);
    const finance = projectScope(env, OTHER_PROJECT_ID);
    assert.ok(roblox && finance, "both project chat lists are adopted");
    assert.strictEqual(ns.scopes.length, 3, "sidebar + two projects");

    // Each tree spans only its own list.
    assert.strictEqual(ns.site.childRows(roblox.historyDiv).length, 3);
    assert.strictEqual(ns.site.childRows(finance.historyDiv).length, 1);
    assert.strictEqual(ns.site.childRows(ns.historyDiv).length, CHATGPT_CHATS.length,
        "project chats never enter the sidebar's own list");
    assert.ok(!roblox.historyDiv.contains(ns.historyDiv) && !ns.historyDiv.contains(roblox.historyDiv));

    // Only the project being viewed is seeded with a starter folder.
    assert.strictEqual(roblox.folderManager.folders.length, 1);
    assert.strictEqual(finance.folderManager.folders.length, 0,
        "a project you are not looking at is left untouched until it has stored folders");
    window.close();
});

test("ChatGPT: a project chat drops into a project folder, persists and restores", async () => {
    const store = {};
    const fixture = { projects: [ROBLOX], url: projectUrl(ROBLOX) };
    const env = await loadExtension("chatgpt-modern", CHATGPT_CHATS, store, fixture);
    const scope = projectScope(env, PROJECT_ID);
    await fileChatInNewFolder(env, "/c/aaa", "Sidebar work");

    const folder = scope.folderManager.createFolder("Systems");
    const row = env.ns.site.childRows(scope.historyDiv)
        .find((el) => env.ns.site.hrefOf(el) === ROBLOX.chats[1].href);
    assert.ok(row && row.__glynChatItem, "the project chat is wired for drag");
    scope.dragController.handleDrop(row.__glynChatItem, folder, folder.el);
    await scope.layoutState.save();
    await settle(env.window);

    assert.strictEqual(env.ns.site.hrefOf(folder.contentsEl.firstElementChild), ROBLOX.chats[1].href);
    assert.strictEqual(env.ns.site.childRows(scope.historyDiv).length, ROBLOX.chats.length - 1);
    env.window.close();

    // Keys are namespaced per project, alongside - never on top of - the sidebar's.
    const keys = Object.keys(store);
    assert.ok(keys.some((key) => key.startsWith(`p:${PROJECT_ID}:f`)), `no project keys in ${keys}`);
    assert.ok(keys.some((key) => /^f\d/.test(key)), "the sidebar keeps its own unprefixed keys");

    const reloaded = await loadExtension("chatgpt-modern", CHATGPT_CHATS, store, fixture);
    const restored = projectScope(reloaded, PROJECT_ID);
    const systems = restored.folderManager.folders
        .find((rec) => rec.folderItem.data.name === "Systems");
    assert.ok(systems, "the project folder is restored");
    const rows = reloaded.ns.site.childRows(systems.contentsEl);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(reloaded.ns.site.hrefOf(rows[0]), ROBLOX.chats[1].href);
    reloaded.window.close();
});

test("project folders collide neither with the sidebar's nor with another project's", async () => {
    const store = {};
    const fixture = { projects: [ROBLOX, FINANCE], url: projectUrl(ROBLOX) };
    const env = await loadExtension("chatgpt-modern", CHATGPT_CHATS, store, fixture);

    env.ns.folderManager.createFolder("Sidebar work");
    projectScope(env, PROJECT_ID).folderManager.createFolder("Roblox work");
    const finance = projectScope(env, OTHER_PROJECT_ID);
    finance.folderManager.createFolder("Finance work");
    await Promise.all(env.ns.scopes.map((scope) => scope.layoutState.save()));
    env.window.close();

    const reloaded = await loadExtension("chatgpt-modern", CHATGPT_CHATS, store, fixture);
    // Array.from re-homes the jsdom-realm array so deepStrictEqual compares values, not realms.
    const names = (scope) =>
        Array.from(scope.folderManager.folders, (rec) => rec.folderItem.data.name);
    assert.deepStrictEqual(names(projectScope(reloaded, PROJECT_ID)).sort(),
        ["New Folder", "Roblox work"]);
    assert.deepStrictEqual(names(projectScope(reloaded, OTHER_PROJECT_ID)), ["Finance work"]);
    assert.ok(names(reloaded.ns.scopes[0]).includes("Sidebar work"));
    assert.ok(!names(reloaded.ns.scopes[0]).includes("Roblox work"),
        "the sidebar must not show a project's folders");
    reloaded.window.close();
});

test("a chat cannot be dragged from the sidebar into a project's folder", async () => {
    const env = await loadExtension("chatgpt-modern", CHATGPT_CHATS, {}, {
        projects: [ROBLOX],
        url: projectUrl(ROBLOX)
    });
    const scope = projectScope(env, PROJECT_ID);
    const folder = scope.folderManager.createFolder("Systems");
    const sidebarRow = env.ns.site.childRows(env.ns.historyDiv)[0];

    // Routed the way a real drop is, through the shared handler rather than one tree's controller.
    env.ns.DraggableElement.dropHandler(sidebarRow.__glynChatItem, folder, folder.el);
    await settle(env.window);

    assert.strictEqual(folder.contentsEl.children.length, 0, "the cross-tree drop is ignored");
    assert.ok(env.ns.site.childRows(env.ns.historyDiv).includes(sidebarRow),
        "the chat stays in the sidebar list");
    env.window.close();
});

test("a project chat list that the app removes takes its tree with it, not its stored layout", async () => {
    const store = {};
    const fixture = { projects: [ROBLOX], url: projectUrl(ROBLOX) };
    const env = await loadExtension("chatgpt-modern", CHATGPT_CHATS, store, fixture);
    const scope = projectScope(env, PROJECT_ID);
    scope.folderManager.createFolder("Systems");
    await scope.layoutState.save();
    const saved = JSON.parse(JSON.stringify(store));

    // Collapsing a project detaches its list; the layout must outlive it.
    scope.historyDiv.parentNode.removeChild(scope.historyDiv);
    await settle(env.window, 60, 25);
    assert.strictEqual(projectScope(env, PROJECT_ID), null, "the tree is torn down");
    assert.deepStrictEqual(store, saved, "a torn-down tree never writes over its own layout");
    env.window.close();
});

test("Claude: project folders are not claimed", async () => {
    const { ns, dom } = await loadExtension("claude", CLAUDE_CHATS, {});
    assert.strictEqual(ns.site.supportsProjectFolders(), false);
    assert.strictEqual(ns.site.findProjectChatLists().length, 0);
    assert.strictEqual(ns.scopes.length, 1, "only the sidebar tree exists");
    dom.window.close();
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
        assert.ok(/^(cl:)?(p:g-p-[0-9a-f]+:)?(f\d+|settings)/.test(key),
            `unexpected storage key ${key}`);
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
