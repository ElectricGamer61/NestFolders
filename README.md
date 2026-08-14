# NestFolders

**Nested folders & project organization for ChatGPT and Claude — bring order to your AI chat history.**

NestFolders is a Chrome/Chromium extension that adds real, unlimited-depth folders to the
sidebar you already use. Folders appear *inside* the native ChatGPT and Claude sidebars — not
in a separate dashboard, popup or note-taking app — so organising a conversation is a drag,
not a workflow.

![Folders in the ChatGPT sidebar](screenshot.png)

## Features

- 🗂️ **Unlimited nesting** — folders inside folders inside folders, as deep as your projects go.
- 🧲 **Drag and drop** — drag conversations into folders, reorder them, and move folders around.
- 🎨 **Colour and rename** — inline rename plus a colour picker per folder.
- 📌 **Folders pinned at the top** — instant access; your chats keep their native order below.
- 🌗 **Follows the host theme** — folder chrome matches ChatGPT's and Claude's light or dark mode.
- 🔄 **Syncs across your Chrome profile** via `chrome.storage.sync`.
- 💾 **Export / import** your folder structure as JSON from the extension popup.
- ⌨️ `Ctrl + \` collapses every folder.

## Supported apps

| App | URL | Status |
| --- | --- | --- |
| ChatGPT | `https://chatgpt.com/*` | Full support (inherited from the upstream project) |
| Claude | `https://claude.ai/*` | Full support (new in NestFolders) |

**ChatGPT and Claude folders are kept separate.** Each app has its own folder tree stored under
its own key namespace, so a chat can never end up in the wrong app's folder and one app's
layout cannot overwrite the other's. A single export file contains both.

## Install (Chrome / Chromium, developer mode)

NestFolders is not on the Chrome Web Store yet. To run it locally:

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome, Chromium, Edge, Brave, or another Chromium browser.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the **`App/`** directory of this repository.
5. Open [chatgpt.com](https://chatgpt.com) or [claude.ai](https://claude.ai). A folder appears at
   the top of the chat list; drag a conversation onto it.

To update, pull the latest changes and press **Reload** on the extension card.

## Privacy

NestFolders never reads, stores, or transmits the contents of your conversations. There is no
server, no analytics, and no network request of any kind — everything stays in your browser
profile.

What is stored, in `chrome.storage.sync` under your own Google account:

- folder names, colours, nesting and ordering;
- conversation **paths** (e.g. `/chat/abc123`) so a chat can be placed in a folder;
- the conversation **title as shown in the sidebar**, so a folder can still list a chat that has
  scrolled out of the app's recent list;
- your UI preferences (folder icon style, sidebar handle, sidebar width).

Nothing else is read from the page. You can export or clear this data at any time from the
extension popup. See [PRIVACY.md](PRIVACY.md) for the full policy.

> Note on titles: the upstream project stored conversation IDs only. NestFolders also stores the
> sidebar title, because Claude lists only recent conversations — without the title, a chat that
> aged out of the list could not be shown in its folder at all. Message content is still never
> touched.

## Limitations

- **Chromium browsers only.** Firefox is not supported yet (Manifest V3 differences).
- **DOM-anchored.** Both apps are third-party sites that can redesign their sidebar at any time.
  If folders stop appearing after a redesign, that is where to look — every selector lives in
  one file, [`App/siteAdapter.js`](App/siteAdapter.js).
- **The sidebar resize handle is ChatGPT-only.** Claude animates and collapses its own sidebar,
  so NestFolders leaves that width alone.
- **Chats not listed by the app appear as stub rows.** They are real links to the conversation,
  shown with the title captured when the chat was last visible.
- **`chrome.storage.sync` has quotas.** Very large folder trees are chunked across keys, but a
  few thousand filed chats is the practical ceiling.
- **Claude Projects are not folders.** NestFolders organises conversations; it does not read or
  modify Claude Projects or ChatGPT Projects.

## Development

```bash
npm install     # dev dependency: jsdom
npm test        # folder/layout/storage suite, run against the real content scripts
node test/browser-smoke.js --screenshot shot.png   # loads the extension in real Chromium
```

`npm test` boots the actual content scripts in jsdom against fixtures shaped like each app's
sidebar, and covers container detection, nesting, drag-drop outcomes, persistence, per-app
storage separation, and export/import. `test/browser-smoke.js` goes further and loads the
unpacked extension into a headless Chromium, serving a synthetic page from the `claude.ai`
origin so injection, layout and theming are exercised for real. Neither can validate the *live*
markup of ChatGPT or Claude — for that, see the manual checklist below.

### Manual checklist (needs a signed-in browser)

For each of ChatGPT and Claude:

1. Folders appear at the top of the chat list and look at home in the sidebar (light **and** dark mode).
2. Create a folder from the popup; rename it inline; give it a colour.
3. Drag a conversation into the folder; it leaves the main list and opens normally when clicked.
4. Create a folder inside a folder, and drag a chat into the nested one.
5. Reload the page: folders, nesting, colours and chat placement all return.
6. Collapse/expand a folder, and `Ctrl + \` to collapse all.
7. Delete a folder and confirm its chats return to the main list.
8. Start a new chat and confirm it appears in the list and can be dragged.
9. Export from the popup, clear storage, re-import, and confirm both apps' folders return.

### Architecture

Everything host-specific — selectors, the chat-row shape, URL format, storage namespace — lives
in `App/siteAdapter.js`. The folder model, drag controller and persistence layer are shared and
know nothing about either app. Adding a third app means adding one adapter definition.

## Credits

NestFolders is a fork of **[glyndavidson/chatgpt-folders](https://github.com/glyndavidson/chatgpt-folders)**
by [Glyn Davidson](https://github.com/glyndavidson), which contributed the nested-folder model,
drag-and-drop and the ChatGPT integration. If you find this useful, consider
[buying Glyn a coffee](https://buymeacoffee.com/glyndavidson).

The Claude integration, the site-adapter layer and the test suite were added in this fork.

## License

MIT — see [LICENSE](LICENSE). Fork it, modify it, build on it.
