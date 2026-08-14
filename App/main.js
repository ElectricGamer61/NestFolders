// @meta main.js bootstraps the content script, wiring managers, drag logic, and storage sync.
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

    let historyDiv = null;
    let historyManager = null;
    let folderManager = null;
    let folderMenu = null;
    let dragController = null;
    let storageService = null;
    let globalSettings = null;
    let layoutState = null;

    let dropMarker = null;
    let highlightedFolderRow = null;
    window.FOLDER_ICON_STYLE = window.FOLDER_ICON_STYLE || "outline";
    let messageListenerBound = false;
    let historyObserver = null;
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
    let historyScanScheduled = false;

    function scheduleSave(opts) {
        if (layoutState) {
            layoutState.markDirty(opts || {});
        }
    }

    function findSidebarContainer() {
        if (!historyDiv) return null;
        return site.findSidebarContainer(historyDiv);
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
        if (!folderManager || typeof folderManager.pinFoldersAtTop !== "function") return;
        folderManager.pinFoldersAtTop();
    }

    function applyGlobalSettings(options) {
        enforceFoldersTopOrder();
        const style = globalSettings ? globalSettings.getFolderIconStyle() : "outline";
        window.FOLDER_ICON_STYLE = style;
        if (folderManager && typeof folderManager.refreshAllFolderIcons === "function") {
            folderManager.refreshAllFolderIcons();
        }
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

    function findHistoryContainer() {
        return site.findHistoryContainer();
    }

    /**
     * Folder chrome is injected into a host app we do not control, so it has to follow the
     * host's light/dark theme. Rather than guessing at vendor theme classes, read the
     * effective background of the sidebar and pick the matching palette.
     */
    function refreshThemeClass() {
        const root = document.documentElement;
        if (!root) return;
        const probe = sidebarContainer || historyDiv || document.body;
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

    function ensureMessageListener() {
        if (messageListenerBound || !chrome || !chrome.runtime || !chrome.runtime.onMessage) return;
        chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
            if (!message || !message.glynCommand) return;
            if (message.glynCommand === "createFolder") {
                if (folderManager) {
                    const folder = folderManager.createFolder("New Folder");
                    if (folder && typeof folder.inlineRename === "function") {
                        folder.inlineRename();
                    }
                    if (folder) {
                        scheduleSave({ immediate: true });
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
                        applyGlobalSettings({ persist: true });
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
                    if (!folderManager || typeof folderManager.setAllFoldersExpanded !== "function") {
                        if (sendResponse) sendResponse({ ok: false, error: "not-ready" });
                        return true;
                    }
                    const expand = message.glynCommand === "expandAllFolders";
                    const changed = folderManager.setAllFoldersExpanded(expand);
                    if (changed) {
                        scheduleSave({ immediate: true });
                    }
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
                        ready: !!folderManager
                    });
                }
                return true;
            }
        });
        messageListenerBound = true;
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
        const isRootContainer = container === historyDiv;
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

    // ---- root chat helpers ----

    function getRootChatLinks() {
        if (!historyDiv) return [];
        return site.childRows(historyDiv);
    }

    function makeRootLinksDraggable() {
        if (!historyDiv || !historyManager) return;

        const rows = getRootChatLinks();
        historyManager.ensureChatOrderFromLinks(rows);

        rows.forEach(row => {
            if (row.__glynChatItem) {
                if (layoutState && typeof layoutState.tryHydrateChat === "function") {
                    layoutState.tryHydrateChat(row.__glynChatItem);
                }
                return;
            }
            const href = site.hrefOf(row);
            if (!href) return;
            const item = new ChatItem(row, href, site.titleOf(row));
            row.__glynChatItem = item;
            item.enableDrag();
            if (layoutState && typeof layoutState.tryHydrateChat === "function") {
                layoutState.tryHydrateChat(item);
            }
        });
    }

    /**
     * Both host apps re-render their chat list as you navigate, lazy-load older chats, or
     * rename a conversation. Re-scan on every mutation so new chats become draggable and our
     * folder wrappers survive the host's re-renders. The scan is coalesced into one animation
     * frame and every step it calls is idempotent, so it cannot feed itself indefinitely.
     */
    function scanHistory() {
        makeRootLinksDraggable();
        if (folderManager) {
            if (typeof folderManager.removeDuplicateWrappers === "function") {
                folderManager.removeDuplicateWrappers();
            }
            if (typeof folderManager.ensureFolderMounts === "function") {
                folderManager.ensureFolderMounts();
            }
        }
        enforceFoldersTopOrder();
    }

    function scheduleHistoryScan() {
        if (historyScanScheduled) return;
        historyScanScheduled = true;
        const run = () => {
            historyScanScheduled = false;
            if (!historyDiv || !document.contains(historyDiv)) return;
            scanHistory();
        };
        if (typeof window.requestAnimationFrame === "function") {
            window.requestAnimationFrame(run);
        } else {
            setTimeout(run, 16);
        }
    }

    function observeHistory() {
        if (!historyDiv) return;
        scanHistory();

        if (historyObserver) {
            historyObserver.disconnect();
        }

        historyObserver = new MutationObserver(scheduleHistoryScan);
        historyObserver.observe(historyDiv, {
            childList: true,
            subtree: false
        });
    }

    function stopHistoryObserver() {
        if (historyObserver) {
            historyObserver.disconnect();
            historyObserver = null;
        }
        historyScanScheduled = false;
    }

    function handleGlobalShortcuts(event) {
        if (!folderManager) return;
        const active = document.activeElement;
        if (active) {
            const tag = (active.tagName || "").toLowerCase();
            if (tag === "input" || tag === "textarea" || active.isContentEditable) {
                return;
            }
        }
        if (event.ctrlKey && event.key === "\\") {
            event.preventDefault();
            const changed = folderManager.setAllFoldersExpanded(false);
            if (changed) {
                scheduleSave({ immediate: true });
            }
        }
    }

    function startContainerMonitor() {
        if (!ENABLE_SAFE_REINIT) return;
        stopContainerMonitor();
        containerMonitorTimer = setInterval(() => {
            if (!historyDiv || !document.contains(historyDiv)) {
                scheduleReinit("container-detached");
            }
        }, 1000);
    }

    function stopContainerMonitor() {
        if (!ENABLE_SAFE_REINIT) return;
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
        if (folderManager) {
            try {
                folderManager.suspendNotifications();
                folderManager.clearAllFolders();
            } catch (err) {
                console.warn("[NestFolders] Failed to clear folders during safe mode", err);
            } finally {
                folderManager.resumeNotifications();
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
        stopHistoryObserver();
        stopContainerMonitor();
        stopThemeWatcher();
        hideDropMarker();
        site.setHistoryContainer(null);
        if (ENABLE_SIDEBAR_RESIZER) {
            teardownSidebarResizer();
        }
        historyManager = null;
        folderManager = null;
        folderMenu = null;
        dragController = null;
        layoutState = null;
        storageService = null;
        globalSettings = null;
        setTimeout(() => {
            reinitPending = false;
            historyDiv = null;
            init();
        }, 300);
    }

    function initOnceHistoryFound() {
        site.setHistoryContainer(historyDiv);
        historyManager = new HistoryManager();
        folderMenu = new FolderMenu();
        folderManager = new FolderManager(historyDiv, historyManager, folderMenu);
        ns.folderManager = folderManager;
        ns.historyManager = historyManager;
        ns.historyDiv = historyDiv;
        dragController = new DragController(
            historyDiv,
            historyManager,
            folderManager
        );
        ns.dragController = dragController;

        storageService = new StorageService({
            area: "sync",
            storageKey: "glynGptState"
        });
        globalSettings = new GlobalSettings(storageService);
        layoutState = new LayoutState(storageService, folderManager, historyManager);
        ns.layoutState = layoutState;
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

        // Wire draggable behaviour
        DraggableElement.showDropMarker = showDropMarker;
        DraggableElement.hideDropMarker = hideDropMarker;
        DraggableElement.highlightDropTarget = highlightFolderRow;
        DraggableElement.unhighlightDropTarget = unhighlightFolderRow;
        DraggableElement.setDropHandler((source, target, containerEl, evt) => {
            dragController.handleDrop(source, target, containerEl, evt);
        });

        // Folder menu callbacks
        folderMenu.onNew = (folderItem) => {
            const newFolder = folderManager.createFolder("New Folder", {
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
            scheduleSave({ immediate: true });
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
        folderMenu.onExpandAll = () => {
            if (folderManager.setAllFoldersExpanded(true)) {
                scheduleSave({ immediate: true });
            }
        };
        folderMenu.onCollapseAll = () => {
            if (folderManager.setAllFoldersExpanded(false)) {
                scheduleSave({ immediate: true });
            }
        };
        folderMenu.onDelete = (folderItem) => {
            folderManager.deleteFolder(folderItem);
        };

        makeRootLinksDraggable();

        const bindChangeHandlers = () => {
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
                scheduleSave(immediate ? { immediate: true } : undefined);
                enforceFoldersTopOrder();
            };
            folderManager.setChangeHandler(onStructureChange);
            historyManager.setChangeHandler(onStructureChange);
        };

        layoutState.restore()
            .then(() => {
                if (!folderManager.folders.length) {
                    folderManager.createInitialFolder("New Folder");
                }
            })
            .catch(() => {
                if (!folderManager.folders.length) {
                    folderManager.createInitialFolder("New Folder");
                }
            })
            .finally(() => {
                bindChangeHandlers();
                enforceFoldersTopOrder();
                observeHistory();
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
            historyDiv = findHistoryContainer();

            if (historyDiv) {
                initOnceHistoryFound();
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
