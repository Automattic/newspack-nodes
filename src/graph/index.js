/**
 * Graph asset entry — emits `build/graph/index.css`, which
 * `Admin::register_graph_style()` registers as the `newspack-nodes-graph`
 * style handle. No JS: the single SCSS import is the payload, which esbuild
 * extracts into the stylesheet.
 *
 * The source sits under `topology-console/` because the console owns those
 * rules, but the console ships as a lazy DevTools tab the hub fetches on first
 * activation, while the hub shell and the debug overlay draw canvases at page
 * load. Binding the rules to the console bundle leaves those surfaces unstyled
 * until someone opens the tab, and importing the SCSS into each bundle instead
 * ships the same rules once per bundle. One entry owns the import; a host opts
 * in by naming the handle as a style dependency.
 * `__tests__/graphAssetOwnership.test.js` fails when any other bundle delivers
 * a graph rule.
 */
import '../topology-console/styles/graph-view.scss';
