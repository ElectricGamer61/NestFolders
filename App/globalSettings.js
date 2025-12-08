(function () {
    // @meta GlobalSettings wraps chrome.storage.sync interactions for user preferences.
    const ns = (window.GlynGPT = window.GlynGPT || {});

    class GlobalSettings {
        constructor(storageService) {
            this.storage = storageService;
            this.key = "settings";
            this.values = {
                v: 2,
                ic: 0,
                sb: null,
                sbh: 1
            };
        }

        async load() {
            if (!this.storage) return this.getValues();
            let raw = null;
            try {
                const data = await this.storage.loadKeys([this.key]);
                raw = data && data[this.key];
            } catch (_err) {
                raw = null;
            }
            if (raw && typeof raw === "string") {
                try {
                    raw = JSON.parse(raw);
                } catch (_err) {
                    raw = null;
                }
            }
            if (raw && typeof raw === "object") {
                this._applyRaw(raw);
            } else {
                await this.save().catch(() => {});
            }
            return this.getValues();
        }

        async save() {
            if (!this.storage) return false;
            return this.storage.saveKeys({ [this.key]: Object.assign({}, this.values) });
        }

        _applyRaw(raw) {
            if (!raw || typeof raw !== "object") return;
            if (typeof raw.v === "number") this.values.v = raw.v;
            if (Object.prototype.hasOwnProperty.call(raw, "ic")) {
                this.values.ic = raw.ic ? 1 : 0;
            }
            if (Object.prototype.hasOwnProperty.call(raw, "sbh")) {
                this.values.sbh = raw.sbh ? 1 : 0;
            }
            if (Object.prototype.hasOwnProperty.call(raw, "sb")) {
                this.values.sb = this._normalizeSidebarWidth(raw.sb);
            }
        }

        setFolderIconStyle(style) {
            this.values.ic = style === "fill" ? 1 : 0;
            return this.save();
        }

        getFolderIconStyle() {
            return this.values.ic === 1 ? "fill" : "outline";
        }

        async setValues(partial) {
            if (partial && typeof partial === "object") {
                if (Object.prototype.hasOwnProperty.call(partial, "folderIconStyle")) {
                    this.values.ic = partial.folderIconStyle === "fill" ? 1 : 0;
                }
                if (Object.prototype.hasOwnProperty.call(partial, "showSidebarHandle")) {
                    this.values.sbh = partial.showSidebarHandle ? 1 : 0;
                }
                if (Object.prototype.hasOwnProperty.call(partial, "sidebarWidth")) {
                    this.values.sb = this._normalizeSidebarWidth(partial.sidebarWidth);
                }
            }
            return this.save();
        }

        getValues() {
            return {
                folderIconStyle: this.getFolderIconStyle(),
                showSidebarHandle: this.getShowSidebarHandle()
            };
        }

        getShowSidebarHandle() {
            return this.values.sbh !== 0;
        }

        setShowSidebarHandle(value) {
            this.values.sbh = value ? 1 : 0;
            return this.save();
        }

        getSidebarWidth() {
            return typeof this.values.sb === "number" && Number.isFinite(this.values.sb)
                ? this.values.sb
                : null;
        }

        setSidebarWidth(width) {
            this.values.sb = this._normalizeSidebarWidth(width);
            return this.save();
        }

        _normalizeSidebarWidth(value) {
            if (typeof value === "number" && Number.isFinite(value)) {
                return Math.round(value);
            }
            if (typeof value === "string") {
                const parsed = parseFloat(value);
                if (!Number.isNaN(parsed)) {
                    return Math.round(parsed);
                }
            }
            return null;
        }
    }

    ns.GlobalSettings = GlobalSettings;
})();
