/**
 * The class of the region below the dashboard shell's header, which is what
 * the page scrolls: the surface around it is fixed and clips. A list
 * virtualized against the page, or a panel opening below the header, measures
 * against this, never the window, which does not scroll here. A leaf, so a
 * consumer reads the name without bundling the shell.
 */
export const PAGE_CONTENT_CLASS = 'newspack-nodes-page-content';
