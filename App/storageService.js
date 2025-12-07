(function () {
    // @meta StorageService abstracts chrome.storage/localStorage access for persistent data.
    const ns = (window.GlynGPT = window.GlynGPT || {});

    class StorageService {
        constructor(options) {
            const opts = options || {};
            this.area = opts.area || "sync";
            this.storageKey = opts.storageKey || "glynFoldersData";
            this._storage = this._detectStorageArea(this.area);
            this._saveQueue = Promise.resolve();
        }

        _detectStorageArea(areaName) {
            if (typeof chrome !== "undefined" &&
                chrome.storage &&
                chrome.storage[areaName]) {
                return chrome.storage[areaName];
            }
            // Fallback to localStorage if chrome.storage is unavailable (e.g. for testing)
            if (typeof window !== "undefined" && window.localStorage) {
                return {
                    get: (keys, callback) => {
                        const result = {};
                        Object.keys(keys).forEach((key) => {
                            const raw = window.localStorage.getItem(key);
                            result[key] = raw ? JSON.parse(raw) : keys[key];
                        });
                        callback(result);
                    },
                    set: (items, callback) => {
                        Object.keys(items).forEach((key) => {
                            window.localStorage.setItem(key, JSON.stringify(items[key]));
                        });
                        if (callback) callback();
                    }
                };
            }
            return null;
        }

        load(defaultValue) {
            return new Promise((resolve) => {
                if (!this._storage) {
                    resolve(defaultValue || null);
                    return;
                }
                this._storage.get({ [this.storageKey]: defaultValue || null }, (result) => {
                    resolve(result ? result[this.storageKey] : defaultValue || null);
                });
            });
        }

        save(patch) {
            if (!patch || typeof patch !== "object") {
                return Promise.resolve(false);
            }
            if (!this._storage) {
                return Promise.resolve(false);
            }
            this._saveQueue = this._saveQueue.then(() => this._applyPatch(patch));
            return this._saveQueue;
        }

        loadKeys(keys) {
            return new Promise((resolve) => {
                if (!this._storage) {
                    resolve({});
                    return;
                }
                this._storage.get(keys, (result) => resolve(result || {}));
            });
        }

        saveKeys(setObj, removeKeys) {
            if (!this._storage) {
                return Promise.resolve(false);
            }
            this._saveQueue = this._saveQueue.then(() => new Promise((resolve) => {
                const doRemove = () => {
                    if (removeKeys && removeKeys.length) {
                        this._storage.remove(removeKeys, () => resolve(true));
                    } else {
                        resolve(true);
                    }
                };
                if (setObj && Object.keys(setObj).length) {
                    this._storage.set(setObj, doRemove);
                } else {
                    doRemove();
                }
            }));
            return this._saveQueue;
        }

        dumpAll() {
            return this.loadKeys(null);
        }

        overwriteAll(map) {
            if (!this._storage) {
                return Promise.resolve(false);
            }
            return this.dumpAll().then((existing) => {
                const currentKeys = Object.keys(existing || {});
                const incomingKeys = map ? Object.keys(map) : [];
                const toRemove = currentKeys.filter((key) => !incomingKeys.includes(key));
                return this.saveKeys(map || {}, toRemove);
            });
        }

        _applyPatch(patch) {
            return new Promise((resolve) => {
                this._storage.get({ [this.storageKey]: {} }, (result) => {
                    const current = result && typeof result[this.storageKey] === "object"
                        ? result[this.storageKey]
                        : {};
                    const next = Object.assign({}, current, patch);
                    this._storage.set({ [this.storageKey]: next }, () => resolve(true));
                });
            });
        }
    }

    ns.StorageService = StorageService;
})();
