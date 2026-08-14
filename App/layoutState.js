 (function () {
    // @meta LayoutState stores folders/chats using compact records split across storage keys.
    // Keys are namespaced per host by the site adapter, so ChatGPT and Claude layouts live
    // side by side in the same storage area without overwriting each other.
    const ns = (window.GlynGPT = window.GlynGPT || {});
    const site = ns.site;

    const LAYOUT_VERSION = 2;
    const ROOT_FOLDER_ID = 0;
    const FOLDER_PREFIX = "f";
    const META_SUFFIX = "__meta";
    const CHUNK_SUFFIX = "__chunk_";
    const CHUNK_SIZE = 7000;
    const TITLE_MAX_LENGTH = 120;

    class LayoutState {
        constructor(storageService, folderManager, historyManager) {
            this.storage = storageService;
            this.folderManager = folderManager;
            this.historyManager = historyManager;
            this.isRestoring = false;
            this._saveTimer = null;
            this._knownFolderIds = new Set();
            this.pendingAssignments = new Map();
            this._folderChunkCounts = new Map();
            this._rootChunkCount = 0;
        }

        _defaultState() {
            return { items: [] };
        }

        async restore() {
            if (!this.storage || !this.folderManager || !this.folderManager.historyDiv) {
                return false;
            }

            this._clearPendingPlaceholders();
            this._folderChunkCounts.clear();
            this._rootChunkCount = 0;

            const rootPayload = await this._loadFolderPayload(ROOT_FOLDER_ID);
            if (!rootPayload) {
                this._knownFolderIds.clear();
                this.data = this._defaultState();
                return false;
            }

            const folderIds = Array.isArray(rootPayload.fi) ? rootPayload.fi : [];
            const folderPayloadMap = new Map();
            if (folderIds.length) {
                for (const folderId of folderIds) {
                    const payload = await this._loadFolderPayload(folderId);
                    if (payload) {
                        folderPayloadMap.set(folderId, payload);
                    }
                }
            }

            this.isRestoring = true;
            this.folderManager.suspendNotifications();
            this.historyManager.suspendNotifications();
            this.folderManager.clearAllFolders();

            const rawEntries = Array.isArray(rootPayload.ch) ? rootPayload.ch : [];
            const entries = rawEntries.filter((entry) => entry && entry.t === "f");
            if (folderPayloadMap && folderPayloadMap.size) {
                // Recover folders whose record survived but whose parent no longer lists them.
                // Only genuinely orphaned ids may be re-mounted at the root: a nested folder is
                // already reached through its parent, and adding it here as well would build it
                // twice and split its chats between the two copies.
                const referenced = new Set();
                entries.forEach((entry) => referenced.add(entry.i));
                folderPayloadMap.forEach((payload) => {
                    const children = Array.isArray(payload.ch) ? payload.ch : [];
                    children.forEach((child) => {
                        if (child && child.t === "f") referenced.add(child.i);
                    });
                });
                folderPayloadMap.forEach((_payload, id) => {
                    if (!referenced.has(id)) {
                        entries.push({ t: "f", i: id });
                    }
                });
            }

            const chatMap = this._collectChatMap();
            this._applyEntries(
                entries,
                this.folderManager.historyDiv,
                null,
                folderPayloadMap,
                chatMap
            );
            if (!this.folderManager.folders.length && folderPayloadMap && folderPayloadMap.size) {
                const fallback = Array.from(folderPayloadMap.keys())
                    .sort((a, b) => a - b)
                    .map((id) => ({ t: "f", i: id }));
                console.warn("[NestFolders] No folders mounted after first pass. Applying fallback list.");
                this._applyEntries(
                    fallback,
                    this.folderManager.historyDiv,
                    null,
                    folderPayloadMap,
                    chatMap
                );
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
            const map = new Map();
            site.queryChatRows(scope).forEach((row) => {
                const href = site.hrefOf(row);
                if (href && !map.has(href)) {
                    map.set(href, row);
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
                    const row = chatMap.get(href);
                    if (!row) {
                        this._registerPendingChat(entry.i, entry.n, containerEl, parentFolder);
                        return;
                    }
                    containerEl.appendChild(row);
                    if (parentFolder && row.__glynChatItem) {
                        parentFolder.addChild(row.__glynChatItem);
                    }
                    return;
                }

                if (entry.t === "f") {
                    const folderPayload = folderPayloadMap.get(entry.i);
                    if (!folderPayload) return;
                    const folderId = this._folderIdFromNumber(entry.i);
                    // Never build the same stored folder twice, whatever the payload claims.
                    if (this.folderManager.getRecordById(folderId)) return;
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

        /**
         * A chat can be filed in a folder without being present in the sidebar: Claude only
         * lists recent conversations and ChatGPT pages its history. Rather than dropping the
         * assignment, we render a stub row - a real link to the conversation, carrying the
         * title captured when it was last seen - which behaves like any other chat row and is
         * swapped for the live row if the sidebar later renders it.
         */
        _registerPendingChat(chatId, title, containerEl, parentFolder) {
            if (!containerEl) {
                containerEl = this.folderManager ? this.folderManager.historyDiv : null;
            }
            if (!containerEl) return;
            const expanded = this._expandChatId(chatId);
            const compactId = this._compactChatId(expanded);
            if (!compactId || this.pendingAssignments.has(compactId)) return;

            const stub = this._createStubRow(compactId, title);
            containerEl.appendChild(stub);
            if (parentFolder && stub.__glynChatItem) {
                parentFolder.addChild(stub.__glynChatItem);
            }

            this.pendingAssignments.set(compactId, {
                container: containerEl,
                parentFolder,
                placeholder: stub
            });
        }

        _createStubRow(compactId, title) {
            const href = this._expandChatId(compactId);
            const stub = document.createElement("div");
            stub.className = "glyn-chat-stub";
            stub.dataset.chatId = compactId;

            const link = document.createElement("a");
            link.className = "glyn-chat-stub-link";
            link.href = href;
            link.textContent = title || "Saved chat";
            link.title = title || href;
            stub.appendChild(link);
            if (title) {
                stub.dataset.chatTitle = title;
            }

            const ChatItem = ns.ChatItem;
            if (ChatItem) {
                const item = new ChatItem(stub, href, title || "");
                stub.__glynChatItem = item;
                item.enableDrag();
            }
            return stub;
        }

        _clearPendingPlaceholders() {
            if (!this.pendingAssignments || !this.pendingAssignments.size) return;
            this.pendingAssignments.forEach(({ placeholder }) => {
                if (placeholder && placeholder.parentNode) {
                    placeholder.parentNode.removeChild(placeholder);
                }
            });
            this.pendingAssignments.clear();
        }

        tryHydrateChat(chatItem) {
            if (!chatItem) return false;
            const compactId = this._compactChatId(chatItem.id || chatItem.href);
            if (!compactId) return false;
            const pending = this.pendingAssignments.get(compactId);
            if (!pending) return false;
            const placeholder = pending.placeholder;
            // The stub may have been dragged elsewhere since it was created, so its current
            // parent - not the one recorded at restore time - is the authoritative location.
            const container = (placeholder && placeholder.parentNode) ||
                pending.container ||
                (pending.parentFolder && pending.parentFolder.contentsEl) ||
                (this.folderManager ? this.folderManager.historyDiv : null);
            if (!container) return false;

            if (placeholder && placeholder.parentNode === container) {
                container.insertBefore(chatItem.el, placeholder);
                if (placeholder.__glynChatItem && pending.parentFolder &&
                    typeof pending.parentFolder.removeChildById === "function") {
                    pending.parentFolder.removeChildById(placeholder.__glynChatItem.id);
                }
                placeholder.parentNode.removeChild(placeholder);
            } else {
                container.appendChild(chatItem.el);
            }

            const folder = this.folderManager
                ? this.folderManager.getRecordByContentsEl(container)
                : null;
            const parentFolder = (folder && folder.folderItem) || pending.parentFolder;
            if (parentFolder) {
                parentFolder.addChild(chatItem);
                if (typeof parentFolder.syncChildrenFromDOM === "function") {
                    parentFolder.syncChildrenFromDOM();
                }
            }

            this.pendingAssignments.delete(compactId);
            return true;
        }

        async save() {
            if (!this.storage) return false;
            const snapshot = this._buildSnapshot();
            const setObj = {};
            const removals = [];

            this._encodeFolderPayload(ROOT_FOLDER_ID, snapshot.root, setObj, removals);
            snapshot.folders.forEach((payload, id) => {
                this._encodeFolderPayload(id, payload, setObj, removals);
            });

            const keptIds = new Set(snapshot.folderIds);
            this._knownFolderIds.forEach((id) => {
                if (!keptIds.has(id)) {
                    const baseKey = this._folderKey(id);
                    removals.push(baseKey, this._metaKeyFor(id));
                    const prevCount = this._folderChunkCounts.get(id) || 0;
                    for (let i = 0; i < prevCount; i += 1) {
                        removals.push(this._chunkKeyFor(id, i));
                    }
                    this._folderChunkCounts.delete(id);
                }
            });

            await this.storage.saveKeys(setObj, removals);
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
            const rootPayload = {};
            if (topLevel.length) {
                rootPayload.ch = topLevel;
            }
            if (folderIds.size) {
                rootPayload.fi = Array.from(folderIds);
            }
            rootPayload.v = LAYOUT_VERSION;
            return {
                root: rootPayload,
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
                if (includeChats && site.isChatRow(node)) {
                    const href = site.hrefOf(node);
                    if (!href) return;
                    const chatId = this._compactChatId(href);
                    if (!chatId) return;
                    const entry = { t: "c", i: chatId };
                    const title = this._titleForRow(node);
                    if (title) {
                        entry.n = title;
                    }
                    entries.push(entry);
                }
            });
            return entries;
        }

        hasFolders() {
            return !!(this.folderManager && this.folderManager.folders.length);
        }

        markDirty(options) {
            if (this.isRestoring) return;
            const immediate = options && options.immediate;
            clearTimeout(this._saveTimer);
            if (immediate) {
                this.save().catch(err => console.warn("[NestFolders] Failed to save layout", err));
                return;
            }
            this._saveTimer = setTimeout(() => {
                this.save().catch(err => console.warn("[NestFolders] Failed to save layout", err));
            }, 250);
        }

        /**
         * The conversation title as shown in the sidebar, trimmed to keep sync storage small.
         * Titles are stored so a folder can still list a chat that has aged out of the
         * sidebar; message content is never read.
         */
        _titleForRow(node) {
            if (node.dataset && node.dataset.chatTitle) {
                return node.dataset.chatTitle.slice(0, TITLE_MAX_LENGTH);
            }
            const title = site.titleOf(node);
            return title ? title.slice(0, TITLE_MAX_LENGTH) : "";
        }

        _compactChatId(href) {
            return site.compactChatId(href);
        }

        _expandChatId(id) {
            return site.expandChatId(id);
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

        _folderKey(id) {
            return site.storageKey(`${FOLDER_PREFIX}${id}`);
        }

        _metaKeyFor(id) {
            return `${this._folderKey(id)}${META_SUFFIX}`;
        }

        _chunkKeyFor(id, index) {
            return `${this._folderKey(id)}${CHUNK_SUFFIX}${index}`;
        }

        async _loadFolderPayload(id) {
            if (!this.storage) return null;
            const baseKey = this._folderKey(id);
            const metaKey = this._metaKeyFor(id);
            const data = await this.storage.loadKeys([baseKey, metaKey]);
            let payload = data && data[baseKey];
            let chunkCount = 0;
            if (!payload) {
                const meta = data && data[metaKey];
                if (!meta || !meta.chunkCount || meta.chunkCount <= 0) {
                    return null;
                }
                chunkCount = meta.chunkCount;
                const chunkKeys = [];
                for (let i = 0; i < chunkCount; i += 1) {
                    chunkKeys.push(this._chunkKeyFor(id, i));
                }
                const chunkData = await this.storage.loadKeys(chunkKeys);
                const serialized = chunkKeys.map((key) => chunkData[key] || "").join("");
                if (!serialized) return null;
                try {
                    payload = JSON.parse(serialized);
                } catch (_err) {
                    console.warn("[NestFolders] Invalid chunked payload:", baseKey);
                    return null;
                }
            } else if (typeof payload === "string") {
                try {
                    payload = JSON.parse(payload);
                } catch (_err) {
                    console.warn("[NestFolders] Invalid payload:", baseKey);
                    return null;
                }
            }
            if (id === ROOT_FOLDER_ID) {
                this._rootChunkCount = chunkCount;
            } else {
                this._folderChunkCounts.set(id, chunkCount);
            }
            return payload;
        }

        _encodeFolderPayload(id, payload, setObj, removals) {
            if (!payload) return;
            const baseKey = this._folderKey(id);
            const metaKey = this._metaKeyFor(id);
            const chunkPrefix = `${baseKey}${CHUNK_SUFFIX}`;
            const prevCount = id === ROOT_FOLDER_ID
                ? this._rootChunkCount
                : (this._folderChunkCounts.get(id) || 0);
            const serialized = JSON.stringify(payload);
            if (serialized.length <= CHUNK_SIZE) {
                setObj[baseKey] = payload;
                if (prevCount > 0) {
                    removals.push(metaKey);
                    for (let i = 0; i < prevCount; i += 1) {
                        removals.push(`${chunkPrefix}${i}`);
                    }
                }
                if (id === ROOT_FOLDER_ID) {
                    this._rootChunkCount = 0;
                } else {
                    this._folderChunkCounts.set(id, 0);
                }
                return;
            }
            const chunkCount = Math.ceil(serialized.length / CHUNK_SIZE);
            for (let i = 0; i < chunkCount; i += 1) {
                const start = i * CHUNK_SIZE;
                const end = start + CHUNK_SIZE;
                setObj[`${chunkPrefix}${i}`] = serialized.slice(start, end);
            }
            setObj[metaKey] = { chunkCount };
            removals.push(baseKey);
            if (prevCount > chunkCount) {
                for (let i = chunkCount; i < prevCount; i += 1) {
                    removals.push(`${chunkPrefix}${i}`);
                }
            }
            if (id === ROOT_FOLDER_ID) {
                this._rootChunkCount = chunkCount;
            } else {
                this._folderChunkCounts.set(id, chunkCount);
            }
        }
    }

    ns.LayoutState = LayoutState;
})();
