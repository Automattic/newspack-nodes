import { useCallback, useEffect, useMemo, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import SchematicCanvas from './SchematicCanvas';
import Inspector from './Inspector';
import Palette from './Palette';
import { useGraphRates } from '../hooks/useGraphRates';
import { useAggregateRateSeries } from '../hooks/useAggregateRateSeries';
import { hullNodes } from '../utils/hullNodes';
import { aggregateSeries } from '../utils/aggregateSeries';

/**
 * The reusable graph-editing surface, shared by the topology console and the
 * debug overlay. Returns a Fragment (no wrapper element) so it drops into the
 * console's existing CSS-grid `topology-app` shell without changing the DOM.
 * Owns selection + Delete-key + rates; data, command handlers, layout props,
 * the canvas `frame`, and display flags are injected.
 *
 * @param {Object}           props
 * @param {Object}           props.graph               { nodes, edges } to render.
 * @param {Function}         props.frame               Component wrapping the canvas (CanvasFrame for the console; a plain frame for the overlay). Receives `frameProps` + children.
 * @param {Object}           props.frameProps          Props forwarded to `frame`.
 * @param {string}           props.resetKey            Identity key; bumps clears rate history.
 * @param {boolean}          props.interactive         Gesture machinery on (default true).
 * @param {boolean}          props.editMode            Draft-only canvas affordances.
 * @param {boolean}          props.showPalette         Render the class palette.
 * @param {boolean}          props.paletteLoading      Catalog fetch-in-flight flag for the palette (default false).
 * @param {Object}           props.classCatalog        shell_name → schema (ports).
 * @param {Array}            props.catalog             Class list (Inspector verbs).
 * @param {Array}            props.formatters          Formatter list (Inspector).
 * @param {Array}            props.vaults              Vault catalog (Inspector, vault_id args).
 * @param {string}           props.streamStatus        For Inspector display.
 * @param {Object}           props.positionOverrides   Layout positions (consumer-owned).
 * @param {Function}         props.onPositionChange    (id, pos)
 * @param {Object}           props.viewport
 * @param {Function}         props.onViewportChange    (viewport)
 * @param {Function}         props.onConnect           (from, to)
 * @param {Function}         props.onRemoveNode        (id)
 * @param {Function}         props.onRemoveEdge        (from, to)
 * @param {Function}         props.onDropNode          (shellName, pos)
 * @param {Function}         props.onInspectorAction   (action, nodeId, payload)
 * @param {Function}         props.onRenameNode        (id, next)
 * @param {Function}         props.onUpdateArgs        (id, args)
 * @param {Function}         props.onUpdateVerbs       (id, verbs)
 * @param {boolean}          props.paletteCollapsed    When true, the palette renders as a slim expand-handle rail (consumer-owned state so the choice can persist across mounts).
 * @param {Function}         props.onPaletteToggle     () — fires when the user clicks the collapse/expand chevron; consumer toggles its `paletteCollapsed` state.
 * @param {Function}         props.onSelectionChange   (selectedId) — optional side-effect.
 * @param {string}           props.selection           Optional controlled selection; when its value changes the internal selection re-syncs to it (lets a consumer re-point selection after a rename or clear it on reset). `undefined` leaves GraphView fully self-controlled.
 * @param {number}           props.bottomObstructionPx Canvas px obstructed at the bottom (expanded transcript overlay); the autofit reserves that band. Default 0.
 * @param {boolean}          props.inspectorCollapsed  When true, the inspector collapses to a slim expand-rail (consumer-owned state, mirrors the palette). Default false.
 * @param {Function}         props.onInspectorToggle   () — fires when the inspector collapse/expand chevron is clicked; consumer toggles its `inspectorCollapsed` state.
 * @param {boolean}          props.local               When true the graph is the browser's own (local) graph, so the no-node header reads wire-accurate IoTelemetry (matching the Overview tab) instead of rolling up dump_metadata. Default false (remote/worker scope).
 * @param {Set<string>|null} props.driftIds            Node ids that exist live but not in the registered .tsl (runtime drift); painted distinctly. null = no drift info.
 * @param {number}           [props.debugLevel]        Live Dumper verbosity dial (0/1/2); the Inspector's no-node Verbose toggle reads it. Default 0.
 * @param {Array}            [props.composeTargets]    The Compose modal's full "To" list (derived from `parsed.nodes`: `_command_interpreter` + every node id + its `:config` sidecar); Inspector falls back to its own node-id list when omitted.
 * @param {Array}            [props.hulls]             One soft hull per directly-declared include: `{ include, nodeIds }[]`, forwarded to SchematicCanvas.
 * @param {Array}            [props.topologies]        `topologies list` entries (each carries `includes`); forwarded to the Palette's "Topologies" drag section.
 * @param {string}           [props.currentTopology]   The topology being edited; disables dragging it (or an ancestor) onto itself.
 * @param {Function}         [props.onDropTopology]    ({ name, x, y }) — a topology dragged from the Palette onto the canvas.
 * @param {Object}           [props.includeTree]       `topologies expand`'s `tree`; forwarded to Inspector's IncludeTree as `tree`.
 * @param {Array}            [props.includes]          The draft's directly-declared includes; forwarded to the Palette (as `declaredIncludes`, to grey out already-included entries) AND to Inspector, which gates both the IncludeTree rows and the hull panel's remove button on it.
 * @param {Function}         [props.onRemoveInclude]   (name) — removes a declared include; reached from the IncludeTree rows, the hull panel's remove button, and the Delete key on a selected hull.
 * @param {Function}         [props.onOpenTopology]    (name) — drill into a hull's topology (open its .tsl).
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
	paletteCollapsed = false,
	onPaletteToggle,
	classCatalog = {},
	catalog = [],
	formatters = [],
	vaults = [],
	streamStatus,
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
	bottomObstructionPx = 0,
	inspectorCollapsed = false,
	onInspectorToggle,
	driftIds = null,
	local = false,
	debugLevel = 0,
	composeTargets,
	hulls = [],
	topologies = [],
	currentTopology = '',
	onDropTopology,
	includeTree = {},
	includes = [],
	onRemoveInclude,
	onOpenTopology,
} ) {
	const [ selectedId, setSelectedId ] = useState( null );
	const [ selectedEdge, setSelectedEdge ] = useState( null );
	// A hull selection is cleared by selecting a node — the node wins.
	const [ selectedHull, setSelectedHull ] = useState( null );
	const [ hoveredId, setHoveredId ] = useState( null );

	// Re-sync to an external controlled selection (rename re-point / reset).
	useEffect( () => {
		if ( selection === undefined ) {
			return;
		}
		setSelectedId( selection );
		// A stale edge must not survive an external selection re-sync.
		setSelectedEdge( null );
	}, [ selection ] );

	const { rateRef, rateVersion } = useGraphRates( graph, resetKey );
	// Aggregate rate series, kept here so it survives the header remounting.
	const rateSeries = useAggregateRateSeries( graph.nodes, resetKey );
	// Derived from the per-node history: selecting a hull reveals the past.
	const hullRateSeries = useMemo(
		() =>
			aggregateSeries(
				rateRef.current,
				hullNodes( graph.nodes, hulls, selectedHull )
			),
		// rateVersion ticks on every poll; rateRef itself is stable.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[ graph.nodes, hulls, selectedHull, rateRef, rateVersion ]
	);

	// Node + edge selection are mutually exclusive (unambiguous Delete).
	const handleSelectNode = useCallback(
		( id ) => {
			setSelectedId( id );
			setSelectedEdge( null );
			setSelectedHull( null );
			onSelectionChange?.( id );
		},
		[ onSelectionChange ]
	);
	const handleSelectEdge = useCallback(
		( edge ) => {
			setSelectedEdge( edge );
			setSelectedId( null );
			// One selection at a time: an edge supersedes a hull.
			setSelectedHull( null );
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
	const handleRemoveHull = useCallback(
		( name ) => {
			// Only a DIRECTLY-declared include has a line here to remove.
			if ( ! includes.includes( name ) ) {
				return;
			}
			onRemoveInclude?.( name );
			setSelectedHull( null );
		},
		[ includes, onRemoveInclude ]
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
				// A borrowed node is locked; not deletable from here.
				const node = graph.nodes.find( ( n ) => n.id === selectedId );
				if ( Array.isArray( node?.origin ) && node.origin.length > 0 ) {
					return;
				}
				e.preventDefault();
				handleRemoveNode( selectedId );
			} else if ( editMode && selectedEdge ) {
				e.preventDefault();
				handleRemoveEdge( selectedEdge.from, selectedEdge.to );
			} else if ( editMode && selectedHull ) {
				if ( ! includes.includes( selectedHull ) ) {
					return;
				}
				e.preventDefault();
				handleRemoveHull( selectedHull );
			}
		};
		document.addEventListener( 'keydown', onKey );
		return () => document.removeEventListener( 'keydown', onKey );
	}, [
		editMode,
		selectedId,
		selectedEdge,
		selectedHull,
		includes,
		graph.nodes,
		handleRemoveNode,
		handleRemoveEdge,
		handleRemoveHull,
	] );

	const nodeIds = new Set( graph.nodes.map( ( n ) => n.id ) );
	const inspectorToggleLabel = inspectorCollapsed
		? __( 'Expand inspector', 'newspack-nodes' )
		: __( 'Collapse inspector', 'newspack-nodes' );

	return (
		<>
			{ showPalette && (
				<Palette
					editMode={ editMode }
					classes={ catalog }
					loading={ paletteLoading }
					collapsed={ paletteCollapsed }
					onToggle={ onPaletteToggle }
					onDropNode={ onDropNode }
					topologies={ topologies }
					currentTopology={ currentTopology }
					declaredIncludes={ includes }
					onDropTopology={ onDropTopology }
				/>
			) }
			<Frame { ...frameProps }>
				<SchematicCanvas
					parsed={ graph }
					driftIds={ driftIds }
					selectedId={ selectedId }
					onSelect={ handleSelectNode }
					selectedHull={ selectedHull }
					onSelectHull={ ( include ) => {
						setSelectedId( null );
						setSelectedEdge( null );
						setSelectedHull( include );
						onSelectionChange?.( null );
					} }
					positionOverrides={ positionOverrides }
					onPositionChange={ onPositionChange }
					onDeselect={ () => {
						setSelectedId( null );
						setSelectedEdge( null );
						// The hull is a selection too — background clears it.
						setSelectedHull( null );
						onSelectionChange?.( null );
					} }
					bottomObstructionPx={ bottomObstructionPx }
					hoveredId={ hoveredId }
					onHover={ setHoveredId }
					rateRef={ rateRef }
					rateVersion={ rateVersion }
					viewport={ viewport }
					onViewportChange={ onViewportChange }
					interactive={ interactive }
					editMode={ editMode }
					onConnect={ onConnect }
					selectedEdge={ selectedEdge }
					onSelectEdge={ handleSelectEdge }
					classCatalog={ classCatalog }
					hulls={ hulls }
				/>
			</Frame>
			{ /* Always present so the show/hide chevron is reachable with no selection. */ }
			{
				<div
					className={ `topology-inspector-dock${
						inspectorCollapsed
							? ' topology-inspector-dock--collapsed'
							: ''
					}` }
				>
					<button
						type="button"
						className="newspack-nodes-rail-toggle topology-inspector__toggle"
						onClick={ () => onInspectorToggle?.() }
						aria-label={ inspectorToggleLabel }
						aria-expanded={ ! inspectorCollapsed }
						title={ inspectorToggleLabel }
					>
						{ inspectorCollapsed ? '‹' : '›' }
					</button>
					{ ! inspectorCollapsed && (
						<Inspector
							selectedId={ selectedId }
							parsed={ graph }
							streamStatus={ streamStatus }
							rateInfo={
								rateRef.current.get( selectedId ) || null
							}
							rateSeries={ rateSeries }
							hullRateSeries={ hullRateSeries }
							local={ local }
							debugLevel={ debugLevel }
							onAction={ onInspectorAction }
							onSelect={ handleSelectNode }
							onHover={ setHoveredId }
							nodeIds={ nodeIds }
							editMode={ editMode }
							catalog={ catalog }
							formatters={ formatters }
							vaults={ vaults }
							onUpdateArgs={ onUpdateArgs }
							onUpdateVerbs={ onUpdateVerbs }
							onRemoveNode={ handleRemoveNode }
							onRenameNode={ onRenameNode }
							onRemoveEdge={ handleRemoveEdge }
							onConnect={ onConnect }
							composeTargets={ composeTargets }
							tree={ includeTree }
							includes={ includes }
							selectedHull={ selectedHull }
							hulls={ hulls }
							onOpenTopology={ onOpenTopology }
							onRemoveInclude={ onRemoveInclude }
							onRemoveHull={ handleRemoveHull }
						/>
					) }
				</div>
			}
		</>
	);
}
