 (function () {
    // @meta LayoutState stores folders/chats using compact records split across storage keys.
    const ns = (window.GlynGPT = window.GlynGPT || {});

    const LAYOUT_VERSION = 1;
    const INDEX_KEY = "layoutIndex";
    const FOLDER_PREFIX = "f";

    class LayoutState {
        constructor(storageService, folderManager, historyManager) {
            this.storage = storageService;
            this.folderManager = folderManager;
            this.historyManager = historyManager;
            this.isRestoring = false;
            this._saveTimer = null;
            this.sidebarWidth = null;
            this._knownFolderIds = new Set();
            this.pendingAssignments = new Map();
        }

        _defaultState() {
            return { items: [], sidebarWidth: null };
        }

        async restore() {
            if (!this.storage || !this.folderManager || !this.folderManager.historyDiv) {
                return false;
            }

            this._clearPendingPlaceholders();

            const indexData = await this.storage.loadKeys([INDEX_KEY]);
            const rawIndex = indexData && indexData[INDEX_KEY];
            if (!rawIndex) {
                this._knownFolderIds.clear();
                this.data = this._defaultState();
                return false;
            }

            let indexPayload;
            try {
                indexPayload = typeof rawIndex === "string" ? JSON.parse(rawIndex) : rawIndex;
            } catch (_err) {
                console.warn("[GlynGPT] Invalid layout index");
                return false;
            }

            const folderIds = Array.isArray(indexPayload.fi) ? indexPayload.fi : [];
            const folderKeys = folderIds.map((id) => FOLDER_PREFIX + id);
            const folderPayloadMap = new Map();
            if (folderKeys.length) {
                const folderData = await this.storage.loadKeys(folderKeys);
                folderKeys.forEach((key, idx) => {
                    const raw = folderData && folderData[key];
                    if (!raw) return;
                    try {
                        folderPayloadMap.set(folderIds[idx], typeof raw === "string" ? JSON.parse(raw) : raw);
                    } catch (_err) {
                        console.warn("[GlynGPT] Invalid folder payload:", key);
                    }
                });
            }

            this.sidebarWidth = this._normalizeSidebarWidth(indexPayload.sb);

            this.isRestoring = true;
            this.folderManager.suspendNotifications();
            this.historyManager.suspendNotifications();
            this.folderManager.clearAllFolders();

            const rawEntries = Array.isArray(indexPayload.tl) ? indexPayload.tl : [];
            const entries = rawEntries.filter((entry) => entry && entry.t === "f");
            if (folderPayloadMap && folderPayloadMap.size) {
                const missing = new Set(Array.from(folderPayloadMap.keys()));
                entries.forEach((entry) => missing.delete(entry.i));
                missing.forEach((id) => entries.push({ t: "f", i: id }));
            }

            console.info("[GlynGPT][Layout] Restoring folders", JSON.stringify({
                requested: entries.length,
                storedFolders: folderPayloadMap.size
            }));

            const chatMap = this._collectChatMap();
            this._applyEntries(
                entries,
                this.folderManager.historyDiv,
                null,
                folderPayloadMap,
                chatMap
            );
            console.info("[GlynGPT][Layout] After apply entries, folder count:", this.folderManager.folders.length);
            if (!this.folderManager.folders.length && folderPayloadMap && folderPayloadMap.size) {
                const fallback = Array.from(folderPayloadMap.keys())
                    .sort((a, b) => a - b)
                    .map((id) => ({ t: "f", i: id }));
                console.warn("[GlynGPT][Layout] No folders mounted after first pass. Applying fallback list.");
                this._applyEntries(
                    fallback,
                    this.folderManager.historyDiv,
                    null,
                    folderPayloadMap,
                    chatMap
                );
                console.warn("[GlynGPT][Layout] Fallback applied. Folder count:", this.folderManager.folders.length);
            }

            const rootLinks = this.folderManager.getRootChatLinks();
            this.historyManager.resetFromLinks(rootLinks);
            if (typeof this.folderManager.removeDuplicateWrappers === "function") {
                this.folderManager.removeDuplicateWrappers();
            }
            if (typeof this.folderManager.ensureFolderMounts === "function") {
                this.folderManager.ensureFolderMounts();
            }
            if (typeof this.folderManager.pinFoldersAtTop === "function") {
                this.folderManager.pinFoldersAtTop();
            }
            this.historyManager.resumeNotifications();
            this.folderManager.resumeNotifications();
            this.isRestoring = false;

            this._knownFolderIds = new Set(folderIds);
            this.data = this._defaultState();
            return true;
        }

        _collectChatMap() {
            const scope = this.folderManager && this.folderManager.historyDiv
                ? this.folderManager.historyDiv
                : document;
            const links = Array.from(scope.querySelectorAll("a.__menu-item"));
            const map = new Map();
            links.forEach((link) => {
                const href = link.getAttribute("href") || "";
                if (href && !map.has(href)) {
                    map.set(href, link);
                }
            });
            return map;
        }

        _applyEntries(entries, containerEl, parentFolder, folderPayloadMap, chatMap) {
            if (!Array.isArray(entries) || !containerEl) return;

            entries.forEach((entry) => {
                if (!entry || typeof entry !== "object") return;
                if (entry.t === "c") {
                    const href = this._expandChatId(entry.i);
                    if (!href) return;
                    const link = chatMap.get(href);
                    if (!link) {
                        this._registerPendingChat(entry.i, containerEl, parentFolder);
                        return;
                    }
                    containerEl.appendChild(link);
                    if (parentFolder && link.__glynChatItem) {
                        parentFolder.addChild(link.__glynChatItem);
                    }
                    return;
                }

                if (entry.t === "f") {
                    const folderPayload = folderPayloadMap.get(entry.i);
                    if (!folderPayload) return;
                    const folderId = this._folderIdFromNumber(entry.i);
                    console.debug("[GlynGPT][Layout] Creating folder", folderPayload.n || "Folder", {
                        id: folderId,
                        parent: parentFolder ? parentFolder.id : null
                    });
                    const folder = this.folderManager.createFolder(folderPayload.n || "Folder", {
                        id: folderId,
                        color: folderPayload["#"] ? `#${folderPayload["#"]}` : null,
                        expanded: true,
                        data: {
                            name: folderPayload.n || "Folder",
                            color: folderPayload["#"] ? `#${folderPayload["#"]}` : null
                        },
                        parentFolder,
                        insertAtTop: false
                    });
                    if (!folder) return;
                    if (typeof folder.setExpanded === "function") {
                        folder.setExpanded(true);
                    } else {
                        folder.data.expanded = true;
                        folder.isExpanded = true;
                        if (folder.contentsEl) {
                            folder.contentsEl.style.display = "";
                        }
                        folder.refreshChevron();
                    }
                    const children = Array.isArray(folderPayload.ch) ? folderPayload.ch : [];
                    this._applyEntries(children, folder.contentsEl, folder, folderPayloadMap, chatMap);
                }
            });
        }

        _registerPendingChat(chatId, containerEl, parentFolder) {
            if (!containerEl) {
                containerEl = this.folderManager ? this.folderManager.historyDiv : null;
            }
            if (!containerEl) return;
            const expanded = this._expandChatId(chatId);
            const compactId = this._compactChatId(expanded);
            if (!compactId || this.pendingAssignments.has(compactId)) return;

            const placeholder = document.createElement("div");
            placeholder.className = "glyn-chat-placeholder";
            placeholder.dataset.chatId = compactId;
            placeholder.textContent = "Loading conversation...";

            containerEl.appendChild(placeholder);

            this.pendingAssignments.set(compactId, {
                container: containerEl,
                parentFolder,
                placeholder
            });
            console.debug("[GlynGPT][Layout] Registered pending chat", compactId, {
                parentFolder: parentFolder ? parentFolder.id : null
            });
        }

        _clearPendingPlaceholders() {
            if (!this.pendingAssignments || !this.pendingAssignments.size) return;
            this.pendingAssignments.forEach(({ placeholder }) => {
                if (placeholder && placeholder.parentNode) {
                    placeholder.parentNode.removeChild(placeholder);
                }
            });
            this.pendingAssignments.clear();
            console.debug("[GlynGPT][Layout] Cleared pending placeholders");
        }

        tryHydrateChat(chatItem) {
            if (!chatItem) return false;
            const compactId = this._compactChatId(chatItem.id || chatItem.href);
            if (!compactId) return false;
            const pending = this.pendingAssignments.get(compactId);
            if (!pending) return false;
            const container = pending.container ||
                (pending.parentFolder && pending.parentFolder.contentsEl) ||
                (this.folderManager ? this.folderManager.historyDiv : null);
            if (!container) return false;

            const placeholder = pending.placeholder;
            if (placeholder && placeholder.parentNode === container) {
                container.insertBefore(chatItem.el, placeholder);
                placeholder.parentNode.removeChild(placeholder);
            } else {
                container.appendChild(chatItem.el);
            }

            if (pending.parentFolder) {
                pending.parentFolder.addChild(chatItem);
                if (typeof pending.parentFolder.syncChildrenFromDOM === "function") {
                    pending.parentFolder.syncChildrenFromDOM();
                }
            }

            this.pendingAssignments.delete(compactId);
            console.info("[GlynGPT][Layout] Hydrated delayed chat", compactId);
            return true;
        }

        async save() {
            if (!this.storage) return false;
            const snapshot = this._buildSnapshot();
            const setObj = {};
            setObj[INDEX_KEY] = JSON.stringify(snapshot.index);
            snapshot.folders.forEach((payload, id) => {
                setObj[FOLDER_PREFIX + id] = JSON.stringify(payload);
            });

            const keptIds = new Set(snapshot.folderIds);
            const removedIds = [];
            this._knownFolderIds.forEach((id) => {
                if (!keptIds.has(id)) {
                    removedIds.push(FOLDER_PREFIX + id);
                }
            });

            await this.storage.saveKeys(setObj, removedIds);
            this._knownFolderIds = keptIds;
            this.data = this._defaultState();
            return true;
        }

        _buildSnapshot() {
            const folderMap = new Map();
            const folderIds = new Set();
            const topLevel = this._serializeContainer(
                this.folderManager ? this.folderManager.historyDiv : null,
                folderMap,
                folderIds,
                {
                    includeChats: false,
                    preventDuplicates: true,
                    seenFolders: new Set()
                }
            );
            const index = {
                v: LAYOUT_VERSION,
                tl: topLevel
            };
            if (this.sidebarWidth) {
                index.sb = Math.round(this.sidebarWidth);
            }
            if (folderIds.size) {
                index.fi = Array.from(folderIds);
            }
            return {
                index,
                folders: folderMap,
                folderIds: Array.from(folderIds)
            };
        }

        _serializeContainer(containerEl, folderMap, folderIds, options) {
            if (!containerEl) return [];
            const includeChats = options && options.includeChats;
            const preventDuplicates = options && options.preventDuplicates;
            const seenFolders = options && options.seenFolders;
            const entries = [];
            Array.from(containerEl.children).forEach((node) => {
                if (node.classList && node.classList.contains("glyn-folder-wrapper")) {
                    const folder = node.__glynFolderItem;
                    if (!folder) return;
                    const idNum = this._folderNumberFromId(folder.id);
                    if (preventDuplicates && seenFolders) {
                        if (seenFolders.has(idNum)) {
                            return;
                        }
                        seenFolders.add(idNum);
                    }
                    folderIds.add(idNum);
                    const payload = {
                        n: folder.data && folder.data.name ? folder.data.name : "Folder"
                    };
                    if (folder.data && folder.data.color) {
                        payload["#"] = folder.data.color.replace(/^#/, "");
                    }
                    const childEntries = this._serializeContainer(
                        folder.contentsEl,
                        folderMap,
                        folderIds,
                        { includeChats: true }
                    );
                    if (childEntries.length) {
                        payload.ch = childEntries;
                    }
                    folderMap.set(idNum, payload);
                    entries.push({ t: "f", i: idNum });
                    return;
                }
                if (includeChats && node.matches && node.matches("a.__menu-item")) {
                    const href = node.getAttribute("href") || "";
                    if (href) {
                        const chatId = this._compactChatId(href);
                        if (chatId) {
                            entries.push({ t: "c", i: chatId });
                        }
                    }
                }
            });
            return entries;
        }

        hasFolders() {
            return !!(this.folderManager && this.folderManager.folders.length);
        }

        getSidebarWidth() {
            return this.sidebarWidth || null;
        }

        setSidebarWidth(width) {
            const normalized = this._normalizeSidebarWidth(width);
            if (normalized === this.sidebarWidth) {
                return;
            }
            this.sidebarWidth = normalized;
            this.markDirty({ immediate: true });
        }

        _normalizeSidebarWidth(value) {
            if (typeof value === "number" && Number.isFinite(value)) {
                return value;
            }
            if (typeof value === "string") {
                const parsed = parseFloat(value);
                if (!Number.isNaN(parsed)) {
                    return parsed;
                }
            }
            return null;
        }

        markDirty(options) {
            if (this.isRestoring) return;
            const immediate = options && options.immediate;
            clearTimeout(this._saveTimer);
            if (immediate) {
                this.save().catch(err => console.warn("[GlynGPT] Failed to save layout", err));
                return;
            }
            this._saveTimer = setTimeout(() => {
                this.save().catch(err => console.warn("[GlynGPT] Failed to save layout", err));
            }, 250);
        }

        _compactChatId(href) {
            if (!href) return null;
            return href.replace(/^\/c\//, "");
        }

        _expandChatId(id) {
            if (!id) return null;
            return id.startsWith("/c/") ? id : `/c/${id}`;
        }

        _folderNumberFromId(id) {
            if (typeof id === "number") return id;
            const match = /(\d+)$/.exec(id || "");
            return match ? parseInt(match[1], 10) : id;
        }

        _folderIdFromNumber(value) {
            if (typeof value === "number") {
                return `folder-${value}`;
            }
            return value;
        }
    }

    ns.LayoutState = LayoutState;
})();
