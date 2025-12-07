(function () {
    // @meta GlobalSettings wraps chrome.storage.sync interactions for user preferences.
    const ns = (window.GlynGPT = window.GlynGPT || {});

    class GlobalSettings {
        constructor(storageService) {
            this.storage = storageService;
            this.key = "globalSettings";
            this.values = {
                folderIconStyle: "outline",
                showSidebarHandle: true
            };
        }

        async load() {
            if (!this.storage) return this.values;
            const data = await this.storage.load({});
            if (data && typeof data === "object" && data[this.key]) {
                this.values = Object.assign({}, this.values, data[this.key]);
            }
            return this.values;
        }

        async save() {
            if (!this.storage) return false;
            return this.storage.save({ [this.key]: this.values });
        }

        setFolderIconStyle(style) {
            this.values.folderIconStyle = this._normalizeIconStyle(style);
            return this.save();
        }

        getFolderIconStyle() {
            return this._normalizeIconStyle(this.values.folderIconStyle);
        }

        async setValues(partial) {
            if (!partial || typeof partial !== "object") {
                return this.save();
            }
            if (Object.prototype.hasOwnProperty.call(partial, "folderIconStyle")) {
                this.values.folderIconStyle = this._normalizeIconStyle(partial.folderIconStyle);
            }
            if (Object.prototype.hasOwnProperty.call(partial, "showSidebarHandle")) {
                this.values.showSidebarHandle = !!partial.showSidebarHandle;
            }
            return this.save();
        }

        getValues() {
            return Object.assign({}, this.values);
        }

        _normalizeIconStyle(style) {
            return style === "fill" ? "fill" : "outline";
        }

        getShowSidebarHandle() {
            return !!this.values.showSidebarHandle;
        }

        setShowSidebarHandle(value) {
            this.values.showSidebarHandle = !!value;
            return this.save();
        }
    }

    ns.GlobalSettings = GlobalSettings;
})();
