/**
 * The head script: the stored skin's `theme-<slug>` on `<html>` before the
 * page paints, from the one store and slug list `theme.js` reads. It imports
 * nothing else, so the build emits a bundle `Admin::enqueue_react_page()`
 * inlines in the head of every page it serves.
 */
import { initSkin } from '../shared/skinStore';

initSkin();
