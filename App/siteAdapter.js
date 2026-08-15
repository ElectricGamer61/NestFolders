(function () {
    // @meta SiteAdapter isolates every host-specific DOM assumption (ChatGPT vs Claude) behind one interface.
    //
    // Vendor sidebar redesigns are the main ongoing maintenance risk for this extension, so all
    // selectors live here and nowhere else. Everything downstream (folders, drag, layout, storage)
    // talks to `GlynGPT.site` and never to a raw site selector.
    //
    // Three concepts matter:
    //   * chat link - the <a href="/c/..."> (ChatGPT) or <a href="/chat/..."> (Claude) element.
    //   * chat row  - the element we actually move around the tree; the element that sits
    //                 directly inside a row container. Depending on the host's markup that is
    //                 either the link itself or the list wrapper around it.
    //   * row container - an element whose *children* are chat rows. There is one per folder
    //                 tree: the main sidebar chat list, plus one per project chat list.
    const ns = (window.GlynGPT = window.GlynGPT || {});

    const FOLDER_CONTENTS_ATTR = "data-glyn-folder-contents";
    const FOLDER_WRAPPER_CLASS = "glyn-folder-wrapper";
    // Our own stand-in row for a filed chat the host app is not currently rendering.
    const CHAT_STUB_CLASS = "glyn-chat-stub";
    const CHAT_STUB_LINK_SELECTOR = ".glyn-chat-stub-link";
    // Stamped on a project's chat list so a re-scan can recognise a list we already adopted
    // even when every one of its chats has been filed into a folder.
    const PROJECT_SCOPE_ATTR = "data-glyn-project-scope";

    const DEFINITIONS = {
        chatgpt: {
            key: "chatgpt",
            label: "ChatGPT",
            hosts: ["chatgpt.com", "www.chatgpt.com", "chat.openai.com"],
            // Empty prefix keeps pre-existing ChatGPT Folders data readable after the rebrand.
            storagePrefix: "",
            chatPathPrefix: "/c/",
            // `data-sidebar-item` is ChatGPT's own marker for a sidebar row; `__menu-item` is
            // the older hook. Either identifies a conversation link, in the main history or in
            // a project's chat list (whose hrefs are /g/g-p-<id>/c/<uuid>).
            chatLinkSelector:
                'a.__menu-item[href*="/c/"], a[data-sidebar-item="true"][href*="/c/"]',
            // Chats that belong to a project carry the project id in their own href, which is
            // what lets a project's chat list be recognised without depending on layout
            // classes. See `findProjectChatLists`.
            projects: {
                label: "project",
                chatLinkSelector:
                    'a.__menu-item[href*="/g/g-p-"][href*="/c/"], a[data-sidebar-item="true"][href*="/g/g-p-"][href*="/c/"]',
                // /g/g-p-<hex>-<slug>/project (sidebar link) and /g/g-p-<hex>/c/<uuid> (chat)
                // must resolve to the same id, so the slug is dropped.
                idFromPath(path) {
                    const match = /^\/g\/(g-p-[^/]+)(?:\/|$)/.exec(path || "");
                    if (!match) return null;
                    const segment = match[1];
                    const rest = segment.slice("g-p-".length).split("-")[0];
                    return rest ? `g-p-${rest}` : null;
                }
            },
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
            // Claude's project chats are plain /chat/<uuid> links: nothing in the row or its
            // href says which project it belongs to, so a project's chat list cannot be told
            // apart from the sidebar's recents the way ChatGPT's can. Left unsupported rather
            // than guessed at; see README's Limitations.
            projects: null,
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

    function isListElement(node) {
        if (!isElement(node)) return false;
        const tag = (node.tagName || "").toLowerCase();
        return tag === "ul" || tag === "ol";
    }

    /**
     * Pick the element that holds the chat list, without relying on class names.
     *
     * For every ancestor of a chat link we count how many of its *direct children* contain at
     * least one chat link. A list container scores once per row (high); a section wrapper that
     * merely groups two lists scores 2. The highest score wins.
     *
     * A single-chat list scores 1 everywhere up the tree, so ties fall back to preferring a
     * real list element (<ul>/<ol>) and then the deepest node - without that, the row's own
     * wrapper would be mistaken for the list that holds it.
     */
    function findChatListContainer(root, selector) {
        if (!root || typeof root.querySelectorAll !== "function") return null;
        return findChatListContainerFromLinks(Array.from(root.querySelectorAll(selector)), root);
    }

    /**
     * Scoring counts only the links it was handed, never every chat link on the page. That is
     * what keeps one project's list from being resolved to the container that happens to hold
     * *all* the projects: that outer container holds more chat links, but only one of the
     * links belonging to the project being placed.
     */
    function findChatListContainerFromLinks(links, root) {
        if (!links || !links.length) return null;

        const stopAt = root ? root.parentElement : null;
        const candidates = new Set();
        links.forEach((link) => {
            let node = link.parentElement;
            while (node && node !== stopAt) {
                if (!isFolderWrapper(node) && !isFolderContents(node)) {
                    candidates.add(node);
                }
                if (node === root) break;
                node = node.parentElement;
            }
        });

        let best = null;
        let bestScore = 0;
        let bestIsList = false;
        let bestDepth = -1;
        candidates.forEach((candidate) => {
            let score = 0;
            Array.from(candidate.children).forEach((child) => {
                if (isFolderWrapper(child)) return;
                if (links.some((link) => link === child || child.contains(link))) {
                    score += 1;
                }
            });
            if (!score) return;
            const isList = isListElement(candidate);
            const depth = depthOf(candidate);
            const better = score > bestScore ||
                (score === bestScore && isList && !bestIsList) ||
                (score === bestScore && isList === bestIsList && depth > bestDepth);
            if (better) {
                best = candidate;
                bestScore = score;
                bestIsList = isList;
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
            // Every adopted chat list: the sidebar's, plus one per project chat list.
            this.rowContainers = new Set();
        }

        setHistoryContainer(el) {
            if (this.historyDiv) {
                this.rowContainers.delete(this.historyDiv);
            }
            this.historyDiv = el || null;
            if (el) {
                this.rowContainers.add(el);
            }
        }

        registerRowContainer(el) {
            if (isElement(el)) {
                this.rowContainers.add(el);
            }
        }

        unregisterRowContainer(el) {
            if (el && el !== this.historyDiv) {
                this.rowContainers.delete(el);
            }
        }

        /** Containers that may hold chat rows: every adopted chat list and every folder body. */
        isRowContainer(node) {
            if (!isElement(node)) return false;
            return node === this.historyDiv || this.rowContainers.has(node) || isFolderContents(node);
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
                    // A named element (e.g. ChatGPT's #history) says *where* the list is, not
                    // that it is the element whose children are the rows: current ChatGPT wraps
                    // the rows in `#history > ul > li`. Descend to the element that actually
                    // holds the rows, which is #history itself on the older flat markup.
                    return findChatListContainer(el, this.chatLinkSelector) || el;
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

        // ---- projects -------------------------------------------------------------------
        //
        // A project's chat list is a second, independent chat list on the same page. It gets
        // its own folder tree, keyed by project id, and is otherwise driven by exactly the
        // same row/folder/drag machinery as the sidebar list.

        supportsProjectFolders() {
            return !!(this.projects && this.projects.chatLinkSelector);
        }

        /** "g-p-<hex>" for any project path or project-scoped chat path, else null. */
        projectIdFromHref(rawHref) {
            if (!this.supportsProjectFolders() || typeof this.projects.idFromPath !== "function") {
                return null;
            }
            return this.projects.idFromPath(this.normalizeHref(rawHref));
        }

        /** The project whose page is currently open, or null. */
        currentProjectId() {
            return this.projectIdFromHref(window.location ? window.location.pathname : "");
        }

        markProjectContainer(el, projectId) {
            if (isElement(el) && projectId && typeof el.setAttribute === "function") {
                // Guarded: this runs from a mutation observer, and writing an attribute queues
                // a record even when the value is unchanged.
                if (el.getAttribute(PROJECT_SCOPE_ATTR) !== projectId) {
                    el.setAttribute(PROJECT_SCOPE_ATTR, projectId);
                }
            }
        }

        /**
         * Every project chat list currently rendered, as `{ projectId, container }`.
         *
         * Grouping is by the project id carried in each chat's own href, so the result does not
         * depend on any layout class. Lists we have already adopted are recognised by their
         * marker attribute as well, so a project whose every chat has been filed into a folder
         * does not look like it has no chat list.
         */
        findProjectChatLists() {
            if (!this.supportsProjectFolders()) return [];

            const byId = new Map();
            const remember = (projectId, container) => {
                if (!projectId || !container) return;
                if (this.historyDiv && (container === this.historyDiv || this.historyDiv.contains(container))) {
                    return;
                }
                if (!byId.has(projectId)) {
                    byId.set(projectId, container);
                }
            };

            Array.from(document.querySelectorAll(`[${PROJECT_SCOPE_ATTR}]`)).forEach((el) => {
                remember(el.getAttribute(PROJECT_SCOPE_ATTR), el);
            });

            const groups = new Map();
            Array.from(document.querySelectorAll(this.projects.chatLinkSelector)).forEach((link) => {
                if (link.closest(`.${FOLDER_WRAPPER_CLASS}`)) return;
                if (this.historyDiv && this.historyDiv.contains(link)) return;
                const projectId = this.projectIdFromHref(link.getAttribute("href"));
                if (!projectId || byId.has(projectId)) return;
                if (!groups.has(projectId)) groups.set(projectId, []);
                groups.get(projectId).push(link);
            });
            groups.forEach((links, projectId) => {
                remember(projectId, findChatListContainerFromLinks(links, null));
            });

            return Array.from(byId, ([projectId, container]) => ({ projectId, container }));
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

        /**
         * Second namespace level, so one project's folders collide neither with the main
         * sidebar's nor with another project's. Keys read `p:<projectId>:f0` (`cl:p:...` on
         * Claude, were it ever supported), leaving the sidebar's existing keys untouched.
         */
        projectKeyPrefix(projectId) {
            return projectId ? `p:${projectId}:` : "";
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
    ns.PROJECT_SCOPE_ATTR = PROJECT_SCOPE_ATTR;
    ns.site = resolveSite(window.location && window.location.hostname);
})();
