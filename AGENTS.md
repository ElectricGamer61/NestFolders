# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## What this is

NestFolders is a Chromium MV3 extension adding nested folders to the ChatGPT and Claude web
sidebars. It is a fork of `glyndavidson/chatgpt-folders` (MIT); attribution must stay in
README, popup and LICENSE. The loadable extension is the `App/` directory; repo root holds
docs and tests.

## Commands

- `npm test` — jsdom suite (`test/run.js`); boots the real content scripts against per-app sidebar fixtures.
- `node test/browser-smoke.js [--screenshot out.png]` — loads the unpacked extension into headless Chromium and serves a synthetic page from the `claude.ai` origin via CDP request interception. Skips cleanly if no Chrome binary is found.
- `node test/project-smoke.js [--screenshots <dir>]` — same harness (`test/chromium.js`) against a ChatGPT project fixture; drives a real drag with dispatched `DragEvent`s and writes desktop + mobile screenshots.
- Manual verification against the live apps is still required; the checklist is in README.md.

## Architecture rule

**Every host-specific assumption belongs in `App/siteAdapter.js`** — selectors, the chat-row
shape, URL format, storage namespace, whether the sidebar resizer applies. Nothing else may
reference an app's DOM. Vendor sidebar redesigns are the standing maintenance risk, so a
redesign should be a one-file fix. Adding an app = adding one adapter definition + manifest
matches + the popup host list (a test asserts those stay in step).

The DOM unit that moves between folders is the **chat row**, not the `<a>` — the element sitting
directly inside a row container, which is the list wrapper around the link on both hosts' current
markup. Use `site.rowFromLink`, `site.childRows`, `site.hrefOf`, `site.titleOf` rather than
touching links directly, and never assume the link *is* the row.

A page holds one folder tree per chat list, not one per page. `main.js` builds a **scope** for
each: the sidebar's, plus one per ChatGPT project chat list (`site.findProjectChatLists()`).
A scope owns its own `FolderManager`/`HistoryManager`/`DragController`/`LayoutState` and its own
storage prefix (`site.projectKeyPrefix`); `FolderMenu`, settings, theming and the drop marker are
global. `ns.folderManager`/`ns.historyDiv` still point at the sidebar scope; `ns.scopes` is all of
them. Project lists come and go as the app re-renders, so `reconcileProjectScopes` mounts and
tears them down on the container-monitor tick — teardown must never save (see `LayoutState#dispose`),
or a collapsed project would erase its own stored layout.

## Sharp edges

- **Never write a class/attribute unconditionally from inside a MutationObserver callback.**
  Setting an attribute queues a mutation record even when the value is unchanged, which
  self-triggers the observer and hangs the page. `refreshThemeClass()` in `main.js` guards on a
  cached value for exactly this reason; `pinFoldersAtTop()` has the same guard for childList.
- Internal identifiers (`window.GlynGPT`, `glyn-*` CSS classes, `data-glyn-*`) are inherited
  from upstream and deliberately unrenamed, to keep the fork diff reviewable and stored data
  compatible. Only user-visible surfaces were rebranded.
- ChatGPT layout keys are unprefixed (`f0`, `f1`, …) so existing users' data survives the fork;
  Claude keys use the `cl:` prefix, and a project's own tree adds `p:g-p-<id>:` on top. Do not
  renumber or reprefix ChatGPT keys.
- A ChatGPT project's chats are identified by the project id in their **own href**
  (`/g/g-p-<hex>/c/<uuid>`); the project's sidebar link adds a slug (`/g/g-p-<hex>-<slug>/project`),
  so both go through `site.projectIdFromHref` to normalise. Claude's project chats carry no such
  marker, which is why project folders are ChatGPT-only.
- A chat filed in a folder but not currently listed by the app renders as a **stub row**
  (`.glyn-chat-stub`), which serialises like a real row. Dropping that behaviour silently
  deletes folder membership for any chat that has scrolled out of the app's list.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
