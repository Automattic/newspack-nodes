/**
 * Theme asset entry — emits `build/theme/index.css`, which
 * `Admin::register_theme_style()` registers as the `newspack-nodes-theme`
 * style handle. No JS: the single SCSS import is the payload, which esbuild
 * extracts into the stylesheet.
 *
 * The `--np-*` product tokens ship as a registered stylesheet rather than as
 * SCSS each dashboard imports, because their consumers span repos.
 * Event-logger-nodes and pyrobase name the handle as a style dependency and
 * carry `.newspack-nodes-theme` on their dashboard roots, then resolve
 * `var(--np-*)` against it — no SCSS sharing and no build coupling, which
 * works standalone because this plugin is a hard runtime dependency of both.
 * Importing the tokens per bundle would give each sibling its own copy of the
 * palette instead.
 */
import './newspack-theme.scss';
