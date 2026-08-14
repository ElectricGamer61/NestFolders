(function () {
    // @meta ChatItem module wraps individual chat rows as draggable elements within the sidebar.
    const ns = (window.GlynGPT = window.GlynGPT || {});
    const DraggableElement = ns.DraggableElement;

    class ChatItem extends DraggableElement {
        // `domElement` is the chat row (see siteAdapter.js): the <a> itself on ChatGPT, or the
        // list wrapper around it on Claude. `href` is the normalised path used as the chat id.
        constructor(domElement, href, title) {
            super(domElement, href, "chat");
            this.href = href;
            this.title = title;
        }
    }

    ns.ChatItem = ChatItem;
})();
