/**
 * ConsoleShell — the canvas surface shared by the debug overlay and the
 * topology console: Header + (ready-gated) GraphView + ReplFooter. Purely
 * presentational; every theme/path/graph/layout/handler/completion/transcript/
 * reset-chip value is injected via props. The console renders its edit toolbar,
 * topology picker, and modals as SIBLINGS of this shell (NOT absorbed here);
 * the overlay renders it bare inside its floating panel.
 */

import Header from './Header';
import GraphView from './GraphView';
import ReplFooter from './ReplFooter';

/**
 * @param {Object}   props
 * @param {boolean}  props.ready             Gate: GraphView renders only when true; else the building placeholder.
 * @param {Object}   props.graph             { nodes, edges } for GraphView.
 * @param {Function} props.frame             Canvas wrapper component (CanvasFrame).
 * @param {Object}   props.frameProps        Props forwarded to `frame` (incl. reset-chip callbacks).
 * @param {Object}   props.canvasProps       Remaining GraphView props (layout/handlers/catalog/etc.).
 * @param {Object}   props.headerProps       Props forwarded to Header.
 * @param {Object}   props.replProps         Props forwarded to ReplFooter.
 * @param {boolean}  props.showRepl          Render the ReplFooter (default true; console passes mode!=='edit').
 * @param {string}   props.buildingClassName CSS class for the not-ready placeholder.
 * @param {Function} props.wrapHeader        Optional (headerEl) => node; wraps the Header (overlay drag chrome). Identity by default.
 * @param {boolean}  props.showHeader        Render the Header (default true; the overlay sets false because the panel owns one shared header above the tabs).
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
					// The transcript obstruction is only real while the REPL is on
					// screen; in edit mode (no REPL) its last-reported height is
					// stale, so the autofit must not reserve a band for it.
					bottomObstructionPx={
						showRepl ? canvasProps.bottomObstructionPx : 0
					}
				/>
			) : (
				<div className={ buildingClassName } />
			) }
			{ showRepl && <ReplFooter { ...replProps } /> }
		</>
	);
}
