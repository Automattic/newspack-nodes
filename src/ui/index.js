/**
 * UI asset entry — emits `build/ui/index.css`, which
 * `Admin::register_ui_style()` registers as the `newspack-nodes-ui` style
 * handle, declaring `newspack-nodes-theme` as its dependency. No JS: the
 * single SCSS import is the payload, which esbuild extracts into the
 * stylesheet.
 *
 * This entry is the only consumer of the seven `shared/styles/` partials it
 * pulls in — controls, buttons, focus, components, toolbar, modal and
 * distinctive-roles. They compile once here rather than once per dashboard
 * bundle, and the component rules scope under `.newspack-nodes-ui`, so a host
 * opts in by carrying that class on its root and naming the handle instead of
 * importing the SCSS.
 *
 * The appearance rules stay a separate handle from the `--np-*` tokens because
 * a consumer can want one without the other: pyrobase's editor pages name
 * `newspack-nodes-theme` alone, taking the palette without the component skin.
 */
import './newspack-nodes-ui.scss';
