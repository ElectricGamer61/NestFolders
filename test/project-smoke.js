"use strict";
/*
 * Real-browser smoke test for folders inside a ChatGPT project's chat list.
 *
 * The fixture is a transcription of a signed-in ChatGPT sidebar (element shapes, class hooks
 * and href formats), served from the chatgpt.com origin through CDP request interception so
 * the content script injects for real. The drag is driven with genuine DragEvents dispatched
 * at the same elements a mouse would hit, so it goes through the extension's own listeners
 * rather than calling its API.
 *
 *   node test/project-smoke.js [--chrome /path/to/chrome] [--screenshots <dir>]
 */

const path = require("path");
const { launch, wait } = require("./chromium");

const PROJECT_ID = "g-p-68ee40f272548191b206b8f939a83182";
const PROJECT_URL = `https://chatgpt.com/g/${PROJECT_ID}-roblox-dev/project`;

const projectChat = (id, title) =>
    `<li class="list-none"><a class="group __menu-item hoverable ps-9" data-sidebar-item="true"
        draggable="true" href="/g/${PROJECT_ID}/c/${id}"
        aria-label="${title}, chat in project Roblox dev"><div class="truncate"><span dir="auto">${title}</span></div>
        <div class="trailing"><button data-conversation-options-trigger="${id}">···</button></div></a></li>`;

const historyChat = (id, title) =>
    `<li class="list-none"><a class="group __menu-item hoverable" data-sidebar-item="true"
        href="/c/${id}" aria-label="${title}"><div class="truncate"><span dir="auto">${title}</span></div></a></li>`;

const FIXTURE = `<!doctype html>
<html><head><title>ChatGPT</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { --sidebar-width: 280px; }
  body { margin:0; background:#212121; color:#ececec;
         font-family:"Segoe UI", system-ui, sans-serif; font-size:14px; }
  nav { width:var(--sidebar-width); height:100vh; background:#181818; padding:8px;
        box-sizing:border-box; overflow-y:auto; }
  ul { list-style:none; margin:0; padding:0; }
  .__menu-item { display:flex; align-items:center; justify-content:space-between; gap:8px;
                 padding:7px 10px; border-radius:8px; color:inherit; text-decoration:none; }
  .__menu-item:hover { background:#2a2a2a; }
  .ps-9 { padding-left:26px; }
  .truncate { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .trailing button { background:none; border:0; color:#8f8f8f; cursor:pointer; }
  .heading { color:#8f8f8f; font-size:12px; padding:14px 10px 6px; }
  @media (max-width: 480px) { :root { --sidebar-width: 100vw; } }
</style></head>
<body>
  <nav aria-label="Chat history">
    <div class="heading">Projects</div>
    <div class="sidebar-expando-section">
      <ul class="m-0 list-none p-0">
        <li class="list-none">
          <a class="group __menu-item hoverable" data-sidebar-item="true"
             href="/g/${PROJECT_ID}-roblox-dev/project">Roblox dev</a>
          <div id="_r_1_" class="overflow-hidden">
            <ul class="m-0 list-none p-0">
              ${projectChat("p-111", "Datastore design")}
              ${projectChat("p-222", "NPC pathfinding")}
              ${projectChat("p-333", "Rojo setup")}
              ${projectChat("p-444", "Ragdoll physics")}
            </ul>
          </div>
        </li>
      </ul>
    </div>
    <div class="heading">Chats</div>
    <div id="history">
      <ul class="m-0 list-none p-0">
        ${historyChat("aaa", "Roadmap planning")}
        ${historyChat("bbb", "Bug triage")}
        ${historyChat("ccc", "Holiday ideas")}
      </ul>
    </div>
  </nav>
</body></html>`;

/**
 * A drag, as the browser would deliver it. The extension listens on the row and on the folder
 * row, so dispatching real DragEvents at those elements exercises the same path a mouse does;
 * only the synthetic dataTransfer is missing, which the handlers already tolerate.
 */
const DRAG = (chatHref, folderName) => `(() => {
    const link = document.querySelector('a[href="' + ${JSON.stringify(chatHref)} + '"]');
    const row = link.closest("li");
    const folderRow = Array.from(document.querySelectorAll(".glyn-folder-row"))
        .find((el) => el.innerText.trim().startsWith(${JSON.stringify(folderName)}));
    if (!row || !folderRow) return { ok: false, reason: "row or folder not found" };
    const fire = (el, type) => el.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true }));
    fire(row, "dragstart");
    fire(folderRow, "dragover");
    fire(folderRow, "drop");
    fire(row, "dragend");
    return { ok: true };
})()`;

const REPORT = `(() => {
    const projectList = document.querySelector('#_r_1_ ul');
    const historyList = document.querySelector('#history ul');
    const inProject = projectList.querySelector(".glyn-folder-wrapper");
    const contents = inProject && inProject.querySelector("[data-glyn-folder-contents]");
    const rowStyle = inProject ? getComputedStyle(inProject.querySelector(".glyn-folder-row")) : null;
    const hrefs = (el) => Array.from(el.querySelectorAll('a[href*="/c/"]'), (a) => a.getAttribute("href"));
    return {
        themeClass: document.documentElement.className,
        projectFolderCount: projectList.querySelectorAll(":scope > .glyn-folder-wrapper").length,
        projectFolderIsFirst: !!(projectList.firstElementChild &&
            projectList.firstElementChild.classList.contains("glyn-folder-wrapper")),
        projectFolderLabel: inProject ? inProject.querySelector(".glyn-folder-row").innerText.trim() : null,
        filedInProjectFolder: contents ? hrefs(contents) : [],
        projectRowsLeft: Array.from(projectList.children)
            .filter((el) => !el.classList.contains("glyn-folder-wrapper")).length,
        sidebarFolderCount: historyList.querySelectorAll(":scope > .glyn-folder-wrapper").length,
        sidebarChatCount: Array.from(historyList.children)
            .filter((el) => !el.classList.contains("glyn-folder-wrapper")).length,
        folderIconRendered: !!(inProject && inProject.querySelector(".glyn-folder-icon svg")),
        folderVisible: !!(rowStyle && rowStyle.display !== "none" && rowStyle.visibility !== "hidden")
    };
})()`;

async function main() {
    const browser = await launch();
    if (!browser) {
        console.log("SKIP: no Chrome/Chromium binary found (pass --chrome <path> or set CHROME_PATH)");
        process.exit(0);
    }

    await browser.serve("https://chatgpt.com/*", FIXTURE);
    await browser.client.send("Page.enable", {}, browser.sessionId);
    await browser.client.send("Page.navigate", { url: PROJECT_URL }, browser.sessionId);
    await wait(4000);

    const dragged = await browser.evaluate(DRAG(`/g/${PROJECT_ID}/c/p-222`, "New Folder"));
    if (!dragged || !dragged.ok) {
        console.log(`FAIL  could not perform the drag: ${dragged && dragged.reason}`);
        browser.close();
        process.exit(1);
    }
    await wait(1000);

    const report = await browser.evaluate(REPORT);
    console.log(JSON.stringify(report, null, 2));

    const shotIndex = process.argv.indexOf("--screenshots");
    if (shotIndex !== -1 && process.argv[shotIndex + 1]) {
        const dir = process.argv[shotIndex + 1];
        // Cropped to the sidebar: the rest of the fixture is an empty stand-in for the chat pane.
        await browser.screenshot(path.join(dir, "project-folders-desktop.png"),
            { width: 1280, height: 800, clip: { width: 420, height: 420 } });
        await browser.screenshot(path.join(dir, "project-folders-mobile.png"),
            { width: 390, height: 844, mobile: true, clip: { width: 390, height: 420 } });
        console.log(`screenshots written to ${dir}`);
    }

    browser.close();

    const failures = [];
    if (!/glyn-site-chatgpt/.test(report.themeClass)) failures.push("the ChatGPT site adapter did not activate");
    if (report.projectFolderCount !== 1) failures.push("no folder was created in the project's chat list");
    if (!report.projectFolderIsFirst) failures.push("the project folder is not pinned above the project's chats");
    if (report.filedInProjectFolder.length !== 1) failures.push("the dragged chat did not land in the project folder");
    if (report.filedInProjectFolder[0] !== `/g/${PROJECT_ID}/c/p-222`) failures.push("the wrong chat was filed");
    if (report.projectRowsLeft !== 3) failures.push("the project list should have one fewer loose chat");
    if (report.sidebarFolderCount !== 1) failures.push("the sidebar's own folder tree is missing");
    if (report.sidebarChatCount !== 3) failures.push("the sidebar's chats were disturbed");
    if (!report.folderIconRendered) failures.push("the folder icon did not render");
    if (!report.folderVisible) failures.push("the project folder row is not visible");
    if (!/glyn-theme-dark/.test(report.themeClass)) failures.push("the dark sidebar was not detected as dark");

    if (failures.length) {
        failures.forEach((failure) => console.log(`FAIL  ${failure}`));
        process.exit(1);
    }
    console.log("\nok  a chat drags into a folder inside a ChatGPT project's chat list");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
