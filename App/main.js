// @meta main.js bootstraps the content script, wiring managers, drag logic, and storage sync.
//
// A page can host more than one chat list: the sidebar's, plus one per project chat list the
// host app renders (ChatGPT only - see siteAdapter). Each list gets its own *scope*: its own
// folder tree, history order, drag controller and storage namespace, all built from the same
// shared classes. Everything below that is not per-list - settings, theming, the drop marker,
// the sidebar resizer, the popup message channel - stays global.
(function () {
    const ns = (window.GlynGPT = window.GlynGPT || {});
    const site = ns.site;
    if (!site) {
        // Not a host we support; the content script simply does nothing.
        return;
    }
    const LOG = "[NestFolders]";
    const DraggableElement = ns.DraggableElement;
    const ChatItem = ns.ChatItem;
    const HistoryManager = ns.HistoryManager;
    const FolderManager = ns.FolderManager;
    const FolderMenu = ns.FolderMenu;
    const DragController = ns.DragController;
    const StorageService = ns.StorageService;
    const GlobalSettings = ns.GlobalSettings;
    const LayoutState = ns.LayoutState;
    const SIDEBAR_MIN_WIDTH = 220;
    const SIDEBAR_MAX_RATIO = 0.9; // 90% of viewport width
    const SIDEBAR_WIDTH_VAR = site.sidebarWidthVar;
    const ENABLE_SIDEBAR_RESIZER = site.enableSidebarResizer;
    const ENABLE_SAFE_REINIT = true;
    const DEFAULT_SHOW_SIDEBAR_HANDLE = true;

    /** Every live folder tree. `scopes[0]` is always the sidebar's. */
    const scopes = [];
    let sidebarScope = null;
    let storageService = null;
    let globalSettings = null;
    // One menu element serves every tree; it resolves the tree from the folder it was opened on.
    let folderMenu = null;

    let dropMarker = null;
    let highlightedFolderRow = null;
    window.FOLDER_ICON_STYLE = window.FOLDER_ICON_STYLE || "outline";
    let messageListenerBound = false;
    let containerMonitorTimer = null;
    let reinitPending = false;
    let safeModeActive = false;
    let sidebarContainer = null;
    let sidebarResizerEl = null;
    let sidebarResizeSession = null;
    let shortcutHandlerBound = false;
    let themeObserver = null;
    let themeMediaQuery = null;
    let themeMediaListener = null;
    let appliedTheme = null;

    function scheduleSave(scope, opts) {
        if (scope && scope.layoutState) {
            scope.layoutState.markDirty(opts || {});
        }
    }

    function findSidebarContainer() {
        if (!sidebarScope) return null;
        return site.findSidebarContainer(sidebarScope.historyDiv);
    }

    function applySidebarWidth(width) {
        if (!ENABLE_SIDEBAR_RESIZER || !SIDEBAR_WIDTH_VAR) return;
        if (!sidebarContainer) return;
        const root = document.documentElement;
        if (!root) return;
        const removeInline = () => {
            sidebarContainer.style.removeProperty("width");
            sidebarContainer.style.removeProperty("minWidth");
            sidebarContainer.style.removeProperty("maxWidth");
            sidebarContainer.style.removeProperty("flex");
        };
        if (typeof width !== "number" || Number.isNaN(width)) {
            removeInline();
            root.style.removeProperty(SIDEBAR_WIDTH_VAR);
            return;
        }
        let clamped = width;
        if (typeof SIDEBAR_MIN_WIDTH === "number") {
            clamped = Math.max(SIDEBAR_MIN_WIDTH, clamped);
        }
        if (typeof SIDEBAR_MAX_RATIO === "number" && SIDEBAR_MAX_RATIO > 0) {
            const vwLimit = Math.floor(window.innerWidth * Math.min(SIDEBAR_MAX_RATIO, 1));
            if (vwLimit > 0) {
                clamped = Math.min(vwLimit, clamped);
            }
        }
        removeInline();
        root.style.setProperty(SIDEBAR_WIDTH_VAR, `${clamped}px`);
    }

    function teardownSidebarResizer() {
        if (!ENABLE_SIDEBAR_RESIZER) return;
        if (sidebarResizerEl && sidebarResizerEl.parentNode) {
            sidebarResizerEl.parentNode.removeChild(sidebarResizerEl);
        }
        sidebarResizerEl = null;
        if (sidebarContainer) {
            sidebarContainer.classList.remove("glyn-sidebar-resizable");
            if (sidebarContainer.dataset && sidebarContainer.dataset.glynSidebarPrevPos === "applied") {
                sidebarContainer.style.position = "";
                delete sidebarContainer.dataset.glynSidebarPrevPos;
            }
            if (sidebarContainer.dataset && Object.prototype.hasOwnProperty.call(sidebarContainer.dataset, "glynSidebarPrevPad")) {
                sidebarContainer.style.paddingRight = sidebarContainer.dataset.glynSidebarPrevPad;
                delete sidebarContainer.dataset.glynSidebarPrevPad;
            }
            if (sidebarContainer.dataset && Object.prototype.hasOwnProperty.call(sidebarContainer.dataset, "glynSidebarPrevBox")) {
                sidebarContainer.style.boxSizing = sidebarContainer.dataset.glynSidebarPrevBox;
                delete sidebarContainer.dataset.glynSidebarPrevBox;
            }
        }
        sidebarContainer = null;
    }

    function setupSidebarResizer() {
        if (!ENABLE_SIDEBAR_RESIZER) return;
        const container = findSidebarContainer();
        if (!container) {
            teardownSidebarResizer();
            return;
        }
        if (sidebarContainer && sidebarContainer !== container) {
            teardownSidebarResizer();
        }
        sidebarContainer = container;
        const style = window.getComputedStyle(container);
        if (style.position === "static") {
            container.dataset.glynSidebarPrevPos = "applied";
            container.style.position = "relative";
        }
        if (!Object.prototype.hasOwnProperty.call(container.dataset, "glynSidebarPrevPad")) {
            container.dataset.glynSidebarPrevPad = container.style.paddingRight || "";
        }
        container.style.paddingRight = "14px";
        if (!Object.prototype.hasOwnProperty.call(container.dataset, "glynSidebarPrevBox")) {
            container.dataset.glynSidebarPrevBox = container.style.boxSizing || "";
        }
        container.style.boxSizing = "border-box";
        container.classList.add("glyn-sidebar-resizable");
        if (!sidebarResizerEl) {
            const handle = document.createElement("div");
            handle.id = "glyn-sidebar-resizer";
            handle.title = "Drag to resize";
            handle.addEventListener("mousedown", onSidebarResizeStart);
            container.appendChild(handle);
            sidebarResizerEl = handle;
        }
        const storedWidth = globalSettings ? globalSettings.getSidebarWidth() : null;
        applySidebarWidth(typeof storedWidth === "number" ? storedWidth : null);
    }

    function onSidebarResizeStart(event) {
        if (!ENABLE_SIDEBAR_RESIZER) return;
        if (event.button !== 0 || !sidebarContainer) return;
        event.preventDefault();
        const rect = sidebarContainer.getBoundingClientRect();
        sidebarResizeSession = {
            startX: event.clientX,
            startWidth: rect.width
        };
        document.addEventListener("mousemove", onSidebarResizeMove, true);
        document.addEventListener("mouseup", onSidebarResizeEnd, true);
        document.body.classList.add("glyn-resizing-sidebar");
    }

    function onSidebarResizeMove(event) {
        if (!ENABLE_SIDEBAR_RESIZER) return;
        if (!sidebarResizeSession || !sidebarContainer) return;
        const delta = event.clientX - sidebarResizeSession.startX;
        const width = sidebarResizeSession.startWidth + delta;
        applySidebarWidth(width);
    }

    function onSidebarResizeEnd() {
        if (!ENABLE_SIDEBAR_RESIZER) return;
        if (!sidebarResizeSession) return;
        document.removeEventListener("mousemove", onSidebarResizeMove, true);
        document.removeEventListener("mouseup", onSidebarResizeEnd, true);
        document.body.classList.remove("glyn-resizing-sidebar");
        const finalWidth = sidebarContainer
            ? sidebarContainer.getBoundingClientRect().width
            : null;
        sidebarResizeSession = null;
        if (globalSettings && typeof finalWidth === "number") {
            globalSettings.setSidebarWidth(finalWidth).catch(() => {});
        }
    }

    function enforceFoldersTopOrder() {
        scopes.forEach((scope) => {
            if (scope.folderManager && typeof scope.folderManager.pinFoldersAtTop === "function") {
                scope.folderManager.pinFoldersAtTop();
            }
        });
    }

    function applyGlobalSettings() {
        enforceFoldersTopOrder();
        const style = globalSettings ? globalSettings.getFolderIconStyle() : "outline";
        window.FOLDER_ICON_STYLE = style;
        scopes.forEach((scope) => {
            if (scope.folderManager && typeof scope.folderManager.refreshAllFolderIcons === "function") {
                scope.folderManager.refreshAllFolderIcons();
            }
        });
        const showHandle = globalSettings
            ? globalSettings.getShowSidebarHandle()
            : DEFAULT_SHOW_SIDEBAR_HANDLE;
        const root = document.documentElement;
        if (root) {
            root.classList.toggle("glyn-sidebar-handle-visible", !!showHandle);
        }
        if (ENABLE_SIDEBAR_RESIZER) {
            const savedWidth = globalSettings ? globalSettings.getSidebarWidth() : null;
            applySidebarWidth(typeof savedWidth === "number" ? savedWidth : null);
        }
    }

    /**
     * Folder chrome is injected into a host app we do not control, so it has to follow the
     * host's light/dark theme. Rather than guessing at vendor theme classes, read the
     * effective background of the sidebar and pick the matching palette.
     */
    function refreshThemeClass() {
        const root = document.documentElement;
        if (!root) return;
        const probe = sidebarContainer ||
            (sidebarScope && sidebarScope.historyDiv) ||
            document.body;
        if (!probe) return;
        const next = isLightBackground(probe) ? "light" : "dark";
        // Writing a class attribute queues a mutation record even when the value is
        // unchanged, and this runs from a mutation observer - so only write on a real change,
        // or the observer feeds itself forever.
        if (next === appliedTheme) return;
        appliedTheme = next;
        root.classList.toggle("glyn-theme-light", next === "light");
        root.classList.toggle("glyn-theme-dark", next === "dark");
    }

    function isLightBackground(startEl) {
        let el = startEl;
        while (el && el !== document.documentElement.parentElement) {
            const parsed = parseRgb(window.getComputedStyle(el).backgroundColor);
            if (parsed && parsed.a > 0.2) {
                // Rec. 709 luma; above the midpoint we treat the surface as light.
                return (0.2126 * parsed.r + 0.7152 * parsed.g + 0.0722 * parsed.b) > 140;
            }
            el = el.parentElement;
        }
        return !window.matchMedia || !window.matchMedia("(prefers-color-scheme: dark)").matches;
    }

    function parseRgb(value) {
        const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/i.exec(value || "");
        if (!match) return null;
        return {
            r: parseFloat(match[1]),
            g: parseFloat(match[2]),
            b: parseFloat(match[3]),
            a: match[4] === undefined ? 1 : parseFloat(match[4])
        };
    }

    function startThemeWatcher() {
        stopThemeWatcher();
        if (document.documentElement) {
            document.documentElement.classList.add(`glyn-site-${site.key}`);
        }
        refreshThemeClass();
        themeObserver = new MutationObserver(() => refreshThemeClass());
        themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["class", "style", "data-theme", "data-mode"]
        });
        if (document.body) {
            themeObserver.observe(document.body, {
                attributes: true,
                attributeFilter: ["class", "style", "data-theme", "data-mode"]
            });
        }
        if (window.matchMedia) {
            const query = window.matchMedia("(prefers-color-scheme: dark)");
            if (query && typeof query.addEventListener === "function") {
                themeMediaQuery = query;
                themeMediaListener = () => refreshThemeClass();
                themeMediaQuery.addEventListener("change", themeMediaListener);
            }
        }
    }

    function stopThemeWatcher() {
        if (themeObserver) {
            themeObserver.disconnect();
            themeObserver = null;
        }
        if (themeMediaQuery && themeMediaListener &&
            typeof themeMediaQuery.removeEventListener === "function") {
            themeMediaQuery.removeEventListener("change", themeMediaListener);
        }
        themeMediaQuery = null;
        themeMediaListener = null;
    }

    /**
     * The tree the popup's "New folder" button should act on: the project you are looking at
     * if it has a folder tree, otherwise the sidebar's.
     */
    function activeScope() {
        const projectId = site.supportsProjectFolders() ? site.currentProjectId() : null;
        if (projectId) {
            const match = scopes.find((scope) => scope.projectId === projectId);
            if (match) return match;
        }
        return sidebarScope;
    }

    function ensureMessageListener() {
        if (messageListenerBound || !chrome || !chrome.runtime || !chrome.runtime.onMessage) return;
        chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
            if (!message || !message.glynCommand) return;
            if (message.glynCommand === "createFolder") {
                const scope = activeScope();
                if (scope && scope.folderManager) {
                    const folder = scope.folderManager.createFolder("New Folder");
                    if (folder && typeof folder.inlineRename === "function") {
                        folder.inlineRename();
                    }
                    if (folder) {
                        scheduleSave(scope, { immediate: true });
                        if (sendResponse) sendResponse({ ok: true });
                    } else if (sendResponse) {
                        sendResponse({ ok: false, error: "folder-not-created" });
                    }
                } else if (sendResponse) {
                    sendResponse({ ok: false, error: "not-ready" });
                }
                return true;
            }
            if (message.glynCommand === "settingsChanged") {
                if (!globalSettings) {
                    if (sendResponse) sendResponse({ ok: false, error: "not-ready" });
                    return true;
                }
                const payload = message.payload || {};
                const updates = {};
                if (Object.prototype.hasOwnProperty.call(payload, "folderIconStyle")) {
                    updates.folderIconStyle = payload.folderIconStyle === "fill" ? "fill" : "outline";
                }
                if (Object.prototype.hasOwnProperty.call(payload, "showSidebarHandle")) {
                    updates.showSidebarHandle = !!payload.showSidebarHandle;
                }
                if (!Object.keys(updates).length) {
                    if (sendResponse) sendResponse({ ok: true });
                    return true;
                }
                globalSettings.setValues(updates)
                    .then(() => {
                        applyGlobalSettings();
                        if (sendResponse) sendResponse({ ok: true });
                    })
                    .catch(err => {
                        console.warn("[NestFolders] Failed to apply settings", err);
                        if (sendResponse) sendResponse({ ok: false, error: "apply-failed" });
                    });
                return true;
            }
            if (message.glynCommand === "expandAllFolders" || message.glynCommand === "collapseAllFolders") {
                try {
                    if (!scopes.length) {
                        if (sendResponse) sendResponse({ ok: false, error: "not-ready" });
                        return true;
                    }
                    const expand = message.glynCommand === "expandAllFolders";
                    const changed = setAllFoldersExpanded(expand);
                    if (sendResponse) {
                        sendResponse({ ok: true, changed });
                    }
                } catch (err) {
                    console.warn("[NestFolders] Failed to update folders", err);
                    if (sendResponse) {
                        sendResponse({ ok: false, error: "update-failed" });
                    }
                }
                return true;
            }
            if (message.glynCommand === "getStatus") {
                if (sendResponse) {
                    sendResponse({
                        ok: true,
                        settings: globalSettings ? globalSettings.getValues() : null,
                        ready: !!(sidebarScope && sidebarScope.folderManager)
                    });
                }
                return true;
            }
        });
        messageListenerBound = true;
    }

    function setAllFoldersExpanded(expand) {
        let changed = false;
        scopes.forEach((scope) => {
            if (!scope.folderManager || typeof scope.folderManager.setAllFoldersExpanded !== "function") {
                return;
            }
            if (scope.folderManager.setAllFoldersExpanded(expand)) {
                changed = true;
                scheduleSave(scope, { immediate: true });
            }
        });
        return changed;
    }

    // ---- drop marker + highlight helpers ----

    function ensureDropMarker() {
        if (dropMarker) return;
        dropMarker = document.createElement("div");
        dropMarker.id = "glyn-drop-marker";
        dropMarker.addEventListener("dragover", onDropMarkerDragOver);
        dropMarker.addEventListener("drop", onDropMarkerDrop);
    }

    function onDropMarkerDragOver(evt) {
        if (!DraggableElement || !DraggableElement.currentDrag) return;
        evt.preventDefault();
        if (evt.dataTransfer) {
            evt.dataTransfer.dropEffect = "move";
        }
    }

    function onDropMarkerDrop(evt) {
        if (!DraggableElement ||
            !DraggableElement.currentDrag ||
            !DraggableElement.dropHandler) {
            return;
        }
        evt.preventDefault();

        const source = DraggableElement.currentDrag;
        const container = dropMarker ? dropMarker.parentNode : null;
        if (!container) return;

        const nextEl = dropMarker.nextElementSibling;
        let target = null;
        let beforeElementTarget = null;
        const isRootContainer = scopes.some((scope) => scope.historyDiv === container);
        if (nextEl) {
            if (nextEl.__glynChatItem) {
                target = nextEl.__glynChatItem;
            } else if (nextEl.__glynFolderItem) {
                beforeElementTarget = {
                    type: "before-element",
                    element: nextEl
                };
            } else if (isRootContainer) {
                beforeElementTarget = {
                    type: "before-element",
                    element: nextEl
                };
            }
        } else {
            beforeElementTarget = beforeElementTarget || {
                type: "before-element",
                element: null
            };
        }

        const finalTarget = target || beforeElementTarget;

        DraggableElement.dropHandler(source, finalTarget, container, evt);

        if (DraggableElement.hideDropMarker) {
            DraggableElement.hideDropMarker();
        }
        if (finalTarget && finalTarget.type === "folder" && DraggableElement.unhighlightDropTarget) {
            DraggableElement.unhighlightDropTarget(finalTarget.el);
        }
    }

    function showDropMarker(beforeEl, explicitContainer) {
        let container = explicitContainer || (beforeEl ? beforeEl.parentNode : null);
        if (!container) return;

        if (beforeEl && beforeEl.parentNode &&
            beforeEl.parentNode.classList &&
            beforeEl.parentNode.classList.contains("glyn-folder-wrapper")) {
            beforeEl = beforeEl.parentNode;
            container = beforeEl.parentNode;
        }

        if (!container) return;
        ensureDropMarker();

        const samePosition =
            dropMarker.parentNode === container &&
            (beforeEl ? dropMarker.nextSibling === beforeEl : !dropMarker.nextSibling);

        if (samePosition) {
            return;
        }

        hideDropMarker();
        if (beforeEl) {
            container.insertBefore(dropMarker, beforeEl);
        } else {
            container.appendChild(dropMarker);
        }
    }

    function hideDropMarker() {
        if (dropMarker && dropMarker.parentNode) {
            dropMarker.parentNode.removeChild(dropMarker);
        }
    }

    function highlightFolderRow(rowEl) {
        if (highlightedFolderRow === rowEl) return;
        if (highlightedFolderRow) {
            unhighlightFolderRow(highlightedFolderRow);
        }
        highlightedFolderRow = rowEl;
        if (rowEl) {
            rowEl.classList.add("glyn-folder-row-drop-target");
        }
    }

    function unhighlightFolderRow(rowEl) {
        if (!rowEl) return;
        rowEl.classList.remove("glyn-folder-row-drop-target");
        if (highlightedFolderRow === rowEl) {
            highlightedFolderRow = null;
        }
    }

    // ---- scopes ----

    function scopeForNode(node) {
        if (!node) return null;
        return scopes.find((scope) =>
            scope.historyDiv === node || scope.historyDiv.contains(node)) || null;
    }

    function makeRootLinksDraggable(scope) {
        if (!scope.historyDiv || !scope.historyManager) return;

        const rows = site.childRows(scope.historyDiv);
        scope.historyManager.ensureChatOrderFromLinks(rows);

        rows.forEach(row => {
            if (row.__glynChatItem) {
                if (scope.layoutState && typeof scope.layoutState.tryHydrateChat === "function") {
                    scope.layoutState.tryHydrateChat(row.__glynChatItem);
                }
                return;
            }
            const href = site.hrefOf(row);
            if (!href) return;
            const item = new ChatItem(row, href, site.titleOf(row));
            row.__glynChatItem = item;
            item.enableDrag();
            if (scope.layoutState && typeof scope.layoutState.tryHydrateChat === "function") {
                scope.layoutState.tryHydrateChat(item);
            }
        });
    }

    /**
     * Both host apps re-render their chat lists as you navigate, lazy-load older chats, or
     * rename a conversation. Re-scan on every mutation so new chats become draggable and our
     * folder wrappers survive the host's re-renders. The scan is coalesced into one animation
     * frame and every step it calls is idempotent, so it cannot feed itself indefinitely.
     */
    /**
     * Match the host's own inset for rows in this project's list, so a folder lines up with the
     * chats beside it. Measured from a live row instead of assumed, and only written when it
     * actually changes.
     */
    function applyProjectIndent(scope) {
        if (!scope.projectId || !scope.historyDiv) return;
        const link = scope.historyDiv.querySelector(site.chatLinkSelector);
        if (!link) return;
        const style = window.getComputedStyle(link);
        const inset = style.paddingInlineStart || style.paddingLeft;
        if (!inset || inset === scope.indent) return;
        scope.indent = inset;
        scope.historyDiv.style.setProperty("--glyn-project-indent", inset);
    }

    function scanHistory(scope) {
        makeRootLinksDraggable(scope);
        applyProjectIndent(scope);
        if (scope.folderManager) {
            if (typeof scope.folderManager.removeDuplicateWrappers === "function") {
                scope.folderManager.removeDuplicateWrappers();
            }
            if (typeof scope.folderManager.ensureFolderMounts === "function") {
                scope.folderManager.ensureFolderMounts();
            }
            scope.folderManager.pinFoldersAtTop();
        }
        if (scope.projectId) {
            site.markProjectContainer(scope.historyDiv, scope.projectId);
        }
    }

    function scheduleHistoryScan(scope) {
        if (scope.scanScheduled || scope.disposed) return;
        scope.scanScheduled = true;
        const run = () => {
            scope.scanScheduled = false;
            if (scope.disposed) return;
            if (!scope.historyDiv || !document.contains(scope.historyDiv)) return;
            scanHistory(scope);
        };
        if (typeof window.requestAnimationFrame === "function") {
            window.requestAnimationFrame(run);
        } else {
            setTimeout(run, 16);
        }
    }

    function observeHistory(scope) {
        if (!scope.historyDiv) return;
        scanHistory(scope);

        if (scope.observer) {
            scope.observer.disconnect();
        }
        scope.observer = new MutationObserver(() => scheduleHistoryScan(scope));
        scope.observer.observe(scope.historyDiv, {
            childList: true,
            subtree: false
        });
    }

    function bindScopeChangeHandlers(scope) {
        const immediateReasons = new Set([
            "folder-rename",
            "folder-color",
            "folder-children",
            "create-folder",
            "delete-folder",
            "move-folder",
            "expand-all",
            "collapse-all",
            "ensure",
            "move",
            "remove",
            "set-order"
        ]);
        const onStructureChange = (reason) => {
            const immediate = immediateReasons.has(reason);
            scheduleSave(scope, immediate ? { immediate: true } : undefined);
            enforceFoldersTopOrder();
        };
        scope.folderManager.setChangeHandler(onStructureChange);
        scope.historyManager.setChangeHandler(onStructureChange);
    }

    /**
     * Build a folder tree over one chat list. `projectId` is null for the sidebar's own list.
     * The scope is live immediately; `scope.ready` resolves once the stored layout is applied.
     */
    function createScope(historyDiv, projectId) {
        const scope = {
            projectId: projectId || null,
            historyDiv,
            scanScheduled: false,
            disposed: false,
            observer: null
        };
        if (projectId) {
            site.registerRowContainer(historyDiv);
            site.markProjectContainer(historyDiv, projectId);
        } else {
            site.setHistoryContainer(historyDiv);
        }

        scope.historyManager = new HistoryManager();
        scope.folderManager = new FolderManager(historyDiv, scope.historyManager, folderMenu);
        scope.dragController = new DragController(
            historyDiv,
            scope.historyManager,
            scope.folderManager
        );
        scope.layoutState = new LayoutState(
            storageService,
            scope.folderManager,
            scope.historyManager,
            { keyPrefix: site.projectKeyPrefix(projectId) }
        );

        scopes.push(scope);
        makeRootLinksDraggable(scope);
        applyProjectIndent(scope);

        // Only the project you are actually looking at gets a starter folder: seeding one into
        // every project's list the moment its chats render would rewrite parts of the sidebar
        // the user never asked us to touch.
        const seedInitialFolder = !projectId || projectId === site.currentProjectId();

        scope.ready = scope.layoutState.restore()
            .catch(() => {})
            .then(() => {
                if (scope.disposed) return scope;
                if (!scope.folderManager.folders.length && seedInitialFolder) {
                    scope.folderManager.createInitialFolder("New Folder");
                }
                bindScopeChangeHandlers(scope);
                observeHistory(scope);
                return scope;
            });
        return scope;
    }

    /** The tree that owns a folder, so one shared menu can act on any of them. */
    function scopeForFolder(folderItem) {
        if (!folderItem) return null;
        return scopes.find((scope) =>
            scope.folderManager && !!scope.folderManager.getRecordByFolderItem(folderItem)) || null;
    }

    function wireFolderMenu() {
        folderMenu.onNew = (folderItem) => {
            const scope = scopeForFolder(folderItem);
            if (!scope) return;
            const newFolder = scope.folderManager.createFolder("New Folder", {
                parentFolder: folderItem,
                insertAtTop: true
            });
            if (newFolder) {
                if (typeof folderItem.setExpanded === "function") {
                    folderItem.setExpanded(true);
                }
                if (typeof newFolder.inlineRename === "function") {
                    newFolder.inlineRename();
                }
            }
            scheduleSave(scope, { immediate: true });
        };
        folderMenu.onRename = (folderItem) => {
            folderItem.inlineRename();
        };
        folderMenu.onChangeColor = (folderItem, color) => {
            if (folderItem && typeof folderItem.setColor === "function") {
                folderItem.setColor(color);
            }
            // Persistence handled via layout state change handlers
        };
        folderMenu.onExpandAll = () => setAllFoldersExpanded(true);
        folderMenu.onCollapseAll = () => setAllFoldersExpanded(false);
        folderMenu.onDelete = (folderItem) => {
            const scope = scopeForFolder(folderItem);
            if (scope) {
                scope.folderManager.deleteFolder(folderItem);
            }
        };
    }

    function disposeScope(scope) {
        scope.disposed = true;
        if (scope.observer) {
            scope.observer.disconnect();
            scope.observer = null;
        }
        if (scope.layoutState) {
            scope.layoutState.dispose();
        }
        if (scope.folderManager) {
            scope.folderManager.destroy();
        }
        if (scope.historyManager) {
            scope.historyManager.setChangeHandler(null);
        }
        if (scope.projectId) {
            site.unregisterRowContainer(scope.historyDiv);
        }
        const index = scopes.indexOf(scope);
        if (index !== -1) {
            scopes.splice(index, 1);
        }
    }

    /**
     * Adopt project chat lists that have appeared and drop the ones the host app has removed.
     * A project list comes and goes as the user expands, collapses and navigates, so this runs
     * on the same cheap interval as the sidebar container check.
     */
    function reconcileProjectScopes() {
        if (!site.supportsProjectFolders() || !sidebarScope) return;

        scopes
            .filter((scope) => scope.projectId && !document.contains(scope.historyDiv))
            .forEach(disposeScope);

        const seen = new Set(scopes.filter((s) => s.projectId).map((s) => s.projectId));
        site.findProjectChatLists().forEach(({ projectId, container }) => {
            if (seen.has(projectId)) return;
            if (scopes.some((scope) => scope.historyDiv === container)) return;
            seen.add(projectId);
            const scope = createScope(container, projectId);
            scope.ready.then(() => {
                if (!scope.disposed) {
                    console.info(LOG, `folders ready in project ${projectId}`);
                }
            });
        });
    }

    function handleGlobalShortcuts(event) {
        if (!scopes.length) return;
        const active = document.activeElement;
        if (active) {
            const tag = (active.tagName || "").toLowerCase();
            if (tag === "input" || tag === "textarea" || active.isContentEditable) {
                return;
            }
        }
        if (event.ctrlKey && event.key === "\\") {
            event.preventDefault();
            setAllFoldersExpanded(false);
        }
    }

    function startContainerMonitor() {
        stopContainerMonitor();
        containerMonitorTimer = setInterval(() => {
            if (ENABLE_SAFE_REINIT &&
                (!sidebarScope || !document.contains(sidebarScope.historyDiv))) {
                scheduleReinit("container-detached");
                return;
            }
            reconcileProjectScopes();
        }, 1000);
    }

    function stopContainerMonitor() {
        if (containerMonitorTimer) {
            clearInterval(containerMonitorTimer);
            containerMonitorTimer = null;
        }
    }

    function enterSafeMode(reason) {
        if (!ENABLE_SAFE_REINIT) return;
        if (safeModeActive) return;
        safeModeActive = true;
        console.warn("[NestFolders] Entering safe mode:", reason);
        if (sidebarScope && sidebarScope.folderManager) {
            try {
                sidebarScope.folderManager.suspendNotifications();
                sidebarScope.folderManager.clearAllFolders();
            } catch (err) {
                console.warn("[NestFolders] Failed to clear folders during safe mode", err);
            } finally {
                sidebarScope.folderManager.resumeNotifications();
            }
        }
    }

    function exitSafeMode() {
        safeModeActive = false;
    }

    function scheduleReinit(reason) {
        if (!ENABLE_SAFE_REINIT) return;
        enterSafeMode(reason);
        if (reinitPending) return;
        reinitPending = true;
        console.warn("[NestFolders] Reinitialising folders:", reason);
        stopContainerMonitor();
        stopThemeWatcher();
        hideDropMarker();
        scopes.slice().forEach(disposeScope);
        sidebarScope = null;
        site.setHistoryContainer(null);
        if (ENABLE_SIDEBAR_RESIZER) {
            teardownSidebarResizer();
        }
        storageService = null;
        globalSettings = null;
        setTimeout(() => {
            reinitPending = false;
            init();
        }, 300);
    }

    function initOnceHistoryFound(historyDiv) {
        storageService = new StorageService({
            area: "sync",
            storageKey: "glynGptState"
        });
        globalSettings = new GlobalSettings(storageService);
        folderMenu = new FolderMenu();
        wireFolderMenu();

        site.setHistoryContainer(historyDiv);
        if (ENABLE_SIDEBAR_RESIZER) {
            setupSidebarResizer();
        }
        startThemeWatcher();
        ensureMessageListener();
        if (!shortcutHandlerBound) {
            document.addEventListener("keydown", handleGlobalShortcuts, true);
            shortcutHandlerBound = true;
        }
        globalSettings.load()
            .then(() => applyGlobalSettings())
            .catch(() => applyGlobalSettings());

        // Wire draggable behaviour. The handlers are static, so they route to whichever tree
        // owns the container being dropped into.
        DraggableElement.showDropMarker = showDropMarker;
        DraggableElement.hideDropMarker = hideDropMarker;
        DraggableElement.highlightDropTarget = highlightFolderRow;
        DraggableElement.unhighlightDropTarget = unhighlightFolderRow;
        DraggableElement.setDropHandler((source, target, containerEl, evt) => {
            const scope = scopeForNode(containerEl) ||
                (source && scopeForNode(source.el));
            if (!scope) return;
            // A chat belongs to exactly one list; dragging one across trees would file a chat
            // in a project it is not part of, so those drops are simply ignored.
            if (source && source.el && scopeForNode(source.el) !== scope) return;
            scope.dragController.handleDrop(source, target, containerEl, evt);
        });

        // The sidebar's own tree. `ns.*` keeps pointing at it, so anything that only ever knew
        // about one folder tree (popup handlers, tests) is unaffected by project trees.
        sidebarScope = createScope(historyDiv, null);
        ns.folderManager = sidebarScope.folderManager;
        ns.historyManager = sidebarScope.historyManager;
        ns.dragController = sidebarScope.dragController;
        ns.layoutState = sidebarScope.layoutState;
        ns.historyDiv = sidebarScope.historyDiv;
        ns.scopes = scopes;

        sidebarScope.ready.then(() => {
            enforceFoldersTopOrder();
            reconcileProjectScopes();
            startContainerMonitor();
            refreshThemeClass();
            exitSafeMode();
            console.info(LOG, `folders ready on ${site.label}`);
        });
    }

    // Both hosts are single-page apps: the sidebar can appear long after document_idle (slow
    // network, collapsed sidebar, a route that renders no chat list yet). Poll quickly at
    // first, then settle into a cheap idle poll rather than giving up on the page.
    function init(fastAttempts = 20, fastDelayMs = 250, idleDelayMs = 2000) {
        let attempts = 0;
        let warned = false;

        function check() {
            const historyDiv = site.findHistoryContainer();

            if (historyDiv) {
                initOnceHistoryFound(historyDiv);
                return;
            }

            attempts += 1;
            if (attempts >= fastAttempts && !warned) {
                warned = true;
                console.warn(LOG, `Waiting for the ${site.label} chat list to appear.`);
            }
            setTimeout(check, attempts < fastAttempts ? fastDelayMs : idleDelayMs);
        }

        check();
    }

    init();
})();
