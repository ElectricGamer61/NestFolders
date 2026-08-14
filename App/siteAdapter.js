(function () {
    // @meta SiteAdapter isolates every host-specific DOM assumption (ChatGPT vs Claude) behind one interface.
    //
    // Vendor sidebar redesigns are the main ongoing maintenance risk for this extension, so all
    // selectors live here and nowhere else. Everything downstream (folders, drag, layout, storage)
    // talks to `GlynGPT.site` and never to a raw site selector.
    //
    // Two concepts matter:
    //   * chat link - the <a href="/c/..."> (ChatGPT) or <a href="/chat/..."> (Claude) element.
    //   * chat row  - the element we actually move around the tree. On ChatGPT the link *is* the
    //                 row; on Claude the link is wrapped in list markup, so the row is the
    //                 outer wrapper that is a direct child of the chat list container.
    const ns = (window.GlynGPT = window.GlynGPT || {});

    const FOLDER_CONTENTS_ATTR = "data-glyn-folder-contents";
    const FOLDER_WRAPPER_CLASS = "glyn-folder-wrapper";
    // Our own stand-in row for a filed chat the host app is not currently rendering.
    const CHAT_STUB_CLASS = "glyn-chat-stub";
    const CHAT_STUB_LINK_SELECTOR = ".glyn-chat-stub-link";

    const DEFINITIONS = {
        chatgpt: {
            key: "chatgpt",
            label: "ChatGPT",
            hosts: ["chatgpt.com", "www.chatgpt.com", "chat.openai.com"],
            // Empty prefix keeps pre-existing ChatGPT Folders data readable after the rebrand.
            storagePrefix: "",
            chatPathPrefix: "/c/",
            chatLinkSelector: 'a.__menu-item[href^="/c/"], a.__menu-item[href*="/c/"]',
            sidebarRootSelectors: [
                'nav[aria-label="Chat history"]',
                '[data-testid="left-sidebar"]',
                '[data-testid="left-panel"]',
                "aside"
            ],
            historySelectors: [
                "#history",
                '[data-testid="conversation-sidebar-list"]',
                '[data-testid="conversation-list"]',
                'nav[aria-label="Chat history"] ol',
                'nav[aria-label="Chat history"] div[role="presentation"]'
            ],
            sidebarContainerSelectors: [
                '[data-testid="left-sidebar"]',
                '[data-testid="left-panel"]',
                "aside"
            ],
            enableSidebarResizer: true,
            sidebarWidthVar: "--sidebar-width"
        },
        claude: {
            key: "claude",
            label: "Claude",
            hosts: ["claude.ai", "www.claude.ai"],
            storagePrefix: "cl:",
            chatPathPrefix: "/chat/",
            chatLinkSelector: 'a[href^="/chat/"]',
            sidebarRootSelectors: [
                '[data-testid="menu-sidebar"]',
                'nav[aria-label="Sidebar"]',
                'nav[aria-label*="sidebar" i]',
                "aside",
                "nav"
            ],
            // Claude's sidebar markup carries no stable ids, so structural detection
            // (findChatListContainer) does the real work; these are opportunistic.
            historySelectors: [
                '[data-testid="recents-list"]',
                'nav[aria-label="Sidebar"] ul',
                '[data-testid="menu-sidebar"] ul'
            ],
            sidebarContainerSelectors: [
                '[data-testid="menu-sidebar"]',
                'nav[aria-label="Sidebar"]',
                "aside"
            ],
            // Claude owns its sidebar width (it animates on hover/collapse); adding our own
            // resizer there fights the host app, so it stays a ChatGPT-only feature.
            enableSidebarResizer: false,
            sidebarWidthVar: null
        }
    };

    function isElement(node) {
        return !!(node && node.nodeType === 1);
    }

    function isFolderWrapper(node) {
        return isElement(node) && node.classList && node.classList.contains(FOLDER_WRAPPER_CLASS);
    }

    function isChatStub(node) {
        return isElement(node) && node.classList && node.classList.contains(CHAT_STUB_CLASS);
    }

    function isFolderContents(node) {
        return isElement(node) && typeof node.hasAttribute === "function" && node.hasAttribute(FOLDER_CONTENTS_ATTR);
    }

    /**
     * Pick the element that holds the chat list, without relying on class names.
     *
     * For every ancestor of a chat link we count how many of its *direct children* contain at
     * least one chat link. A list container scores once per row (high); a section wrapper that
     * merely groups two lists scores 2. The highest score wins, deepest node breaking ties.
     */
    function findChatListContainer(root, selector) {
        if (!root || typeof root.querySelectorAll !== "function") return null;
        const links = Array.from(root.querySelectorAll(selector));
        if (!links.length) return null;

        const candidates = new Set();
        links.forEach((link) => {
            let node = link.parentElement;
            while (node && node !== root.parentElement) {
                if (!isFolderWrapper(node) && !isFolderContents(node)) {
                    candidates.add(node);
                }
                if (node === root) break;
                node = node.parentElement;
            }
        });

        let best = null;
        let bestScore = 0;
        let bestDepth = -1;
        candidates.forEach((candidate) => {
            let score = 0;
            Array.from(candidate.children).forEach((child) => {
                if (isFolderWrapper(child)) return;
                if (child.matches(selector) || child.querySelector(selector)) {
                    score += 1;
                }
            });
            if (!score) return;
            const depth = depthOf(candidate);
            if (score > bestScore || (score === bestScore && depth > bestDepth)) {
                best = candidate;
                bestScore = score;
                bestDepth = depth;
            }
        });
        return best;
    }

    function depthOf(node) {
        let depth = 0;
        let current = node;
        while (current && current.parentElement) {
            depth += 1;
            current = current.parentElement;
        }
        return depth;
    }

    class SiteAdapter {
        constructor(definition) {
            Object.assign(this, definition);
            this.historyDiv = null;
        }

        setHistoryContainer(el) {
            this.historyDiv = el || null;
        }

        /** Containers that may hold chat rows: the root chat list and every folder body. */
        isRowContainer(node) {
            if (!isElement(node)) return false;
            return node === this.historyDiv || isFolderContents(node);
        }

        findSidebarRoot() {
            for (const selector of this.sidebarRootSelectors) {
                const candidates = Array.from(document.querySelectorAll(selector));
                const match = candidates.find((el) => el.querySelector(this.chatLinkSelector));
                if (match) return match;
            }
            return null;
        }

        findHistoryContainer() {
            for (const selector of this.historySelectors) {
                const el = document.querySelector(selector);
                if (el && el.querySelector(this.chatLinkSelector)) {
                    return el;
                }
            }
            const root = this.findSidebarRoot();
            if (root) {
                const structural = findChatListContainer(root, this.chatLinkSelector);
                if (structural) return structural;
            }
            // Last resort for a sidebar we failed to recognise: fall back to the first
            // selector match even if it is currently empty (ChatGPT renders #history early).
            for (const selector of this.historySelectors) {
                const el = document.querySelector(selector);
                if (el) return el;
            }
            return null;
        }

        findSidebarContainer(historyDiv) {
            const start = historyDiv || this.historyDiv;
            if (!start) return null;
            for (const selector of this.sidebarContainerSelectors) {
                const match = start.closest(selector);
                if (match) return match;
            }
            const root = this.findSidebarRoot();
            return root || start.parentElement || start;
        }

        /** Every chat row inside `scope` (rows, not links). */
        queryChatRows(scope) {
            const target = scope || this.historyDiv;
            if (!target || typeof target.querySelectorAll !== "function") return [];
            const rows = [];
            const seen = new Set();
            const add = (row) => {
                if (row && !seen.has(row)) {
                    seen.add(row);
                    rows.push(row);
                }
            };
            Array.from(target.querySelectorAll(`.${CHAT_STUB_CLASS}`)).forEach(add);
            Array.from(target.querySelectorAll(this.chatLinkSelector)).forEach((link) => {
                if (link.closest(`.${CHAT_STUB_CLASS}`)) return;
                add(this.rowFromLink(link));
            });
            return rows;
        }

        /** Direct chat-row children of a container, in DOM order. */
        childRows(containerEl) {
            const container = containerEl || this.historyDiv;
            if (!container) return [];
            return Array.from(container.children).filter((child) => this.isChatRow(child));
        }

        /**
         * Walk up from a chat link to the element that sits directly inside a row container.
         * Returns null for links outside the sidebar tree (e.g. the recents grid on Claude's
         * home page), which keeps stray page links out of the folder model.
         */
        rowFromLink(link) {
            if (!isElement(link)) return null;
            let node = link;
            while (node) {
                const parent = node.parentElement;
                if (!parent) return null;
                if (this.isRowContainer(parent)) return node;
                if (isFolderWrapper(parent)) return null;
                node = parent;
            }
            return null;
        }

        isChatRow(node) {
            if (!isElement(node)) return false;
            if (isFolderWrapper(node)) return false;
            if (isChatStub(node)) return true;
            if (typeof node.matches === "function" && node.matches(this.chatLinkSelector)) return true;
            if (typeof node.querySelector !== "function") return false;
            return !!node.querySelector(this.chatLinkSelector);
        }

        linkFromRow(row) {
            if (!isElement(row)) return null;
            if (isChatStub(row)) return row.querySelector(CHAT_STUB_LINK_SELECTOR);
            if (typeof row.matches === "function" && row.matches(this.chatLinkSelector)) return row;
            return typeof row.querySelector === "function"
                ? row.querySelector(this.chatLinkSelector)
                : null;
        }

        /** Stable, origin-free identity for a chat row: its path (e.g. "/chat/<uuid>"). */
        hrefOf(rowOrLink) {
            const link = this.linkFromRow(rowOrLink);
            if (!link) return "";
            return this.normalizeHref(link.getAttribute("href") || "");
        }

        normalizeHref(raw) {
            if (!raw) return "";
            if (raw.charAt(0) === "/") return raw.split("?")[0].split("#")[0];
            try {
                return new URL(raw, window.location.origin).pathname;
            } catch (_err) {
                return raw;
            }
        }

        /**
         * The conversation title. Read from the link rather than the row: Claude's rows also
         * contain a trailing options button whose label would otherwise be appended.
         */
        titleOf(row) {
            if (!isElement(row)) return "";
            const source = this.linkFromRow(row) || row;
            return (source.textContent || "").replace(/\s+/g, " ").trim();
        }

        /** Storage-compact chat id: "/chat/abc" -> "abc". */
        compactChatId(href) {
            if (!href) return null;
            const normalized = this.normalizeHref(href);
            return normalized.startsWith(this.chatPathPrefix)
                ? normalized.slice(this.chatPathPrefix.length)
                : normalized;
        }

        expandChatId(id) {
            if (!id) return null;
            // Anything already path-shaped is returned untouched: ChatGPT also serves
            // GPT-scoped conversations as /g/<gpt>/c/<id>, which compactChatId leaves whole.
            return id.charAt(0) === "/" ? id : `${this.chatPathPrefix}${id}`;
        }

        /** Namespaces layout keys so ChatGPT and Claude folders never overwrite each other. */
        storageKey(key) {
            return `${this.storagePrefix}${key}`;
        }
    }

    function resolveSite(hostname) {
        const host = String(hostname || "").toLowerCase();
        const definition = Object.values(DEFINITIONS).find((def) =>
            def.hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))
        );
        return definition ? new SiteAdapter(definition) : null;
    }

    ns.SiteAdapter = SiteAdapter;
    ns.SITE_DEFINITIONS = DEFINITIONS;
    ns.resolveSite = resolveSite;
    ns.findChatListContainer = findChatListContainer;
    ns.site = resolveSite(window.location && window.location.hostname);
})();
