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

const { launch, wait } = require("./chromium");

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

async function main() {
    const browser = await launch();
    if (!browser) {
        console.log("SKIP: no Chrome/Chromium binary found (pass --chrome <path> or set CHROME_PATH)");
        process.exit(0);
    }

    await browser.serve("https://claude.ai/*", CLAUDE_FIXTURE);
    await browser.client.send("Page.enable", {}, browser.sessionId);
    await browser.client.send("Page.navigate", { url: "https://claude.ai/new" }, browser.sessionId);
    await wait(4000);

    // Content scripts run in an isolated world, so their globals are deliberately not
    // reachable from here: everything below is observed through the page's own DOM.
    const report = await browser.evaluate(`(() => {
        const wrappers = document.querySelectorAll(".glyn-folder-wrapper");
        const row = document.querySelector(".glyn-folder-row");
        const list = document.querySelector("ul.recents");
        const rowStyle = row ? getComputedStyle(row) : null;
        return {
            folderCount: wrappers.length,
            folderLabel: row ? row.innerText.trim() : null,
            folderIsFirstInList: !!(list && list.firstElementChild &&
                list.firstElementChild.classList.contains("glyn-folder-wrapper")),
            chatRowsBelow: list ? list.querySelectorAll('li a[href^="/chat/"]').length : 0,
            themeClass: document.documentElement.className,
            rowVisible: !!(row && row.getBoundingClientRect().width > 50 &&
                rowStyle.display !== "none" && rowStyle.visibility !== "hidden"),
            folderIconRendered: !!document.querySelector(".glyn-folder-icon svg")
        };
    })()`);
    console.log(JSON.stringify(report, null, 2));

    const shotIndex = process.argv.indexOf("--screenshot");
    if (shotIndex !== -1 && process.argv[shotIndex + 1]) {
        await browser.screenshot(process.argv[shotIndex + 1]);
        console.log(`screenshot written to ${process.argv[shotIndex + 1]}`);
    }

    browser.close();

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
