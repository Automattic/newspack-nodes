import { useCallback, useEffect, useState } from '@wordpress/element';
import SchematicCanvas from './SchematicCanvas';
import Inspector from './Inspector';
import Palette from './Palette';
import { useGraphRates } from '../hooks/useGraphRates';
import '../styles/graph-view.scss';

/**
 * The reusable graph-editing surface, shared by the topology console and the
 * debug overlay. Returns a Fragment (no wrapper element) so it drops into the
 * console's existing CSS-grid `topology-app` shell without changing the DOM.
 * Owns selection + Delete-key + rates; data, command handlers, layout props,
 * the canvas `frame`, and display flags are injected.
 *
 * @param {Object}   props
 * @param {Object}   props.graph                     { nodes, edges } to render.
 * @param {Function} props.frame                     Component wrapping the canvas (CanvasFrame for the console; a plain frame for the overlay). Receives `frameProps` + children.
 * @param {Object}   props.frameProps                Props forwarded to `frame`.
 * @param {string}   props.resetKey                  Identity key; bumps clears rate history.
 * @param {boolean}  props.interactive               Gesture machinery on (default true).
 * @param {boolean}  props.editMode                  Draft-only canvas affordances.
 * @param {boolean}  props.showPalette               Render the class palette.
 * @param {boolean}  props.paletteLoading            Catalog fetch-in-flight flag for the palette (default false).
 * @param {Object}   props.classCatalog              shell_name → schema (ports).
 * @param {Array}    props.catalog                   Class list (Inspector verbs).
 * @param {Array}    props.formatters                Formatter list (Inspector).
 * @param {string}   props.streamStatus              For Inspector display.
 * @param {number}   props.ssePid                    For Inspector display.
 * @param {Object}   props.positionOverrides         Layout positions (consumer-owned).
 * @param {Function} props.onPositionChange          (id, pos)
 * @param {Object}   props.viewport
 * @param {Function} props.onViewportChange          (viewport)
 * @param {Function} props.onConnect                 (from, to)
 * @param {Function} props.onRemoveNode              (id)
 * @param {Function} props.onRemoveEdge              (from, to)
 * @param {Function} props.onDropNode                (shellName, pos)
 * @param {Function} props.onInspectorAction         (action, nodeId, payload)
 * @param {Function} props.onRenameNode              (id, next)
 * @param {Function} props.onUpdateArgs              (id, args)
 * @param {Function} props.onUpdateVerbs             (id, verbs)
 * @param {Function} props.onSelectionChange         (selectedId) — optional side-effect.
 * @param {string}   props.selection                 Optional controlled selection; when its value changes the internal selection re-syncs to it (lets a consumer re-point selection after a rename or clear it on reset). `undefined` leaves GraphView fully self-controlled.
 * @param {Function} props.onBackgroundClickConsumed — optional; truthy skips canvas deselect.
 * @return {Element} the graph-editing surface as a Fragment.
 */
export default function GraphView( {
	graph,
	frame: Frame,
	frameProps = {},
	resetKey,
	interactive = true,
	editMode = false,
	showPalette = false,
	paletteLoading = false,
	classCatalog = {},
	catalog = [],
	formatters = [],
	streamStatus,
	ssePid,
	positionOverrides = {},
	onPositionChange,
	viewport = null,
	onViewportChange,
	onConnect,
	onRemoveNode,
	onRemoveEdge,
	onDropNode,
	onInspectorAction,
	onRenameNode,
	onUpdateArgs,
	onUpdateVerbs,
	onSelectionChange,
	selection,
	onBackgroundClickConsumed,
} ) {
	const [ selectedId, setSelectedId ] = useState( null );
	const [ selectedEdge, setSelectedEdge ] = useState( null );
	const [ hoveredId, setHoveredId ] = useState( null );

	// Re-sync to an external controlled selection (rename re-point / reset
	// clear). A no-op for internal clicks, which keep `selection` in lockstep
	// via onSelectionChange.
	useEffect( () => {
		if ( selection === undefined ) {
			return;
		}
		setSelectedId( selection );
		// Selecting a node clears the edge; clearing (null) clears it too —
		// either way a stale edge must not survive an external re-sync.
		setSelectedEdge( null );
	}, [ selection ] );

	const { rateRef, rateVersion } = useGraphRates( graph, resetKey );

	// Node + edge selection are mutually exclusive (unambiguous Delete).
	const handleSelectNode = useCallback(
		( id ) => {
			setSelectedId( id );
			setSelectedEdge( null );
			onSelectionChange?.( id );
		},
		[ onSelectionChange ]
	);
	const handleSelectEdge = useCallback(
		( edge ) => {
			setSelectedEdge( edge );
			setSelectedId( null );
			onSelectionChange?.( null );
		},
		[ onSelectionChange ]
	);

	const handleRemoveNode = useCallback(
		( id ) => {
			onRemoveNode?.( id );
			if ( selectedId === id ) {
				setSelectedId( null );
				onSelectionChange?.( null );
			}
		},
		[ onRemoveNode, selectedId, onSelectionChange ]
	);
	const handleRemoveEdge = useCallback(
		( from, to ) => {
			onRemoveEdge?.( from, to );
			if (
				selectedEdge &&
				selectedEdge.from === from &&
				selectedEdge.to === to
			) {
				setSelectedEdge( null );
			}
		},
		[ onRemoveEdge, selectedEdge ]
	);

	// Delete/Backspace removes the selection (skipped in form fields).
	useEffect( () => {
		const onKey = ( e ) => {
			if ( e.key !== 'Delete' && e.key !== 'Backspace' ) {
				return;
			}
			const tag = e.target && e.target.tagName;
			if ( tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ) {
				return;
			}
			if ( e.target && e.target.isContentEditable ) {
				return;
			}
			if ( selectedId ) {
				e.preventDefault();
				handleRemoveNode( selectedId );
			} else if ( editMode && selectedEdge ) {
				e.preventDefault();
				handleRemoveEdge( selectedEdge.from, selectedEdge.to );
			}
		};
		document.addEventListener( 'keydown', onKey );
		return () => document.removeEventListener( 'keydown', onKey );
	}, [
		editMode,
		selectedId,
		selectedEdge,
		handleRemoveNode,
		handleRemoveEdge,
	] );

	const nodeIds = new Set( graph.nodes.map( ( n ) => n.id ) );

	return (
		<>
			{ showPalette && (
				<Palette classes={ catalog } loading={ paletteLoading } />
			) }
			<Frame { ...frameProps }>
				<SchematicCanvas
					parsed={ graph }
					selectedId={ selectedId }
					onSelect={ handleSelectNode }
					positionOverrides={ positionOverrides }
					onPositionChange={ onPositionChange }
					onDeselect={ () => {
						setSelectedId( null );
						setSelectedEdge( null );
						onSelectionChange?.( null );
					} }
					onBackgroundClickConsumed={ onBackgroundClickConsumed }
					hoveredId={ hoveredId }
					onHover={ setHoveredId }
					rateRef={ rateRef }
					rateVersion={ rateVersion }
					viewport={ viewport }
					onViewportChange={ onViewportChange }
					interactive={ interactive }
					editMode={ editMode }
					onDropNode={ onDropNode }
					onConnect={ onConnect }
					selectedEdge={ selectedEdge }
					onSelectEdge={ handleSelectEdge }
					classCatalog={ classCatalog }
				/>
			</Frame>
			{ selectedId && (
				<Inspector
					selectedId={ selectedId }
					parsed={ graph }
					streamStatus={ streamStatus }
					rateInfo={ rateRef.current.get( selectedId ) || null }
					onAction={ onInspectorAction }
					onSelect={ handleSelectNode }
					onHover={ setHoveredId }
					nodeIds={ nodeIds }
					ssePid={ ssePid }
					editMode={ editMode }
					catalog={ catalog }
					formatters={ formatters }
					onUpdateArgs={ onUpdateArgs }
					onUpdateVerbs={ onUpdateVerbs }
					onRemoveNode={ handleRemoveNode }
					onRenameNode={ onRenameNode }
					onRemoveEdge={ handleRemoveEdge }
					onConnect={ onConnect }
				/>
			) }
		</>
	);
}
