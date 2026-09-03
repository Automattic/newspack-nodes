/**
 * The canvas surface both graph UIs mount: the topology console page and the
 * debug overlay's Console tab. It owns the vertical order — Header, canvas,
 * REPL footer — and the ready gate in front of the canvas, and holds no state
 * of its own, so the theme, graph, layout, handlers, completion, transcript
 * and reset chips all arrive as props.
 *
 * Whatever belongs to ONE host stays a sibling of this shell: the console's
 * edit toolbar, topology picker and modals, the overlay's floating panel
 * chrome. That is what keeps edit-mode concerns out of the surface the overlay
 * renders.
 *
 * It returns a Fragment. Each host wraps it in the `.topology-app` CSS grid,
 * whose children claim the `canvas` and `repl` grid areas by class, so a
 * wrapper element here would strand them outside their cells.
 */

import Header from './Header';
import GraphView from './GraphView';
import ReplFooter from './ReplFooter';

/**
 * Wrapper a host puts around the rendered Header to add chrome of its own — a
 * drag handle, say — without this shell knowing about it.
 *
 * @typedef {(header: import('react').ReactElement) => import('react').ReactNode} HeaderWrapper
 */

/**
 * @param {Object}                      props
 * @param {boolean}                     props.ready               Render GraphView; false renders the placeholder instead. Each host passes the flag it also hands `useCanvasLayout`, so the canvas never mounts before the graph has nodes and their stored positions.
 * @param {Object}                      props.graph               `{ nodes, edges }` for GraphView.
 * @param {import('react').ElementType} props.frame               Component GraphView wraps the canvas in — `CanvasFrame` in both hosts.
 * @param {Object}                      [props.frameProps]        Props forwarded to `frame`: the scope meta line plus the layout and graph reset chips, each hidden by passing a null handler rather than a flag.
 * @param {Object}                      [props.canvasProps]       The rest of GraphView's contract — `resetKey`, layout, handlers, catalog, display flags. Spread last, so a key here beats `graph`, `frame` and `frameProps`.
 * @param {Object}                      [props.headerProps]       Props forwarded to Header.
 * @param {Object}                      [props.replProps]         Props forwarded to ReplFooter.
 * @param {boolean}                     [props.showRepl]          Render the ReplFooter (default true). The console omits it in edit mode, where the draft is not a running graph and the grid drops the REPL row.
 * @param {string}                      [props.buildingClassName] Class for the not-ready placeholder. Each host names its own, because that class is what parks the div in the host's `canvas` grid area.
 * @param {boolean}                     [props.showHeader]        Render the Header (default true). Both hosts pass false: the devtools hub and the overlay panel each own one shared header above the tab bar, and the active tab portals its controls into it.
 * @param {HeaderWrapper}               [props.wrapHeader]        Wraps the rendered Header. Identity by default.
 * @return {import('react').ReactElement} The shared canvas surface as a Fragment.
 */
export default function ConsoleShell( {
	ready,
	graph,
	frame,
	frameProps = {},
	canvasProps = {},
	headerProps = {},
	replProps = {},
	showRepl = true,
	showHeader = true,
	buildingClassName = 'topology-canvas-building',
	wrapHeader = ( header ) => header,
} ) {
	return (
		<>
			{ showHeader && wrapHeader( <Header { ...headerProps } /> ) }
			{ ready ? (
				<GraphView
					graph={ graph }
					frame={ frame }
					frameProps={ frameProps }
					{ ...canvasProps }
				/>
			) : (
				<div className={ buildingClassName } />
			) }
			{ showRepl && <ReplFooter { ...replProps } /> }
		</>
	);
}
