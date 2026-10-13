import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import SchematicCanvas from './SchematicCanvas';
import Inspector from './Inspector';
import Palette from './Palette';
import SidecarsModal from './SidecarsModal';
import { useGraphRates } from '../hooks/useGraphRates';
import { useSidecarRows } from '../hooks/useSidecarRows';
import { usePublishedGraph } from '../hooks/useGraphSource';
import { hullNodes } from '../utils/hullNodes';
import { aggregateSeries } from '../utils/aggregateSeries';

/**
 * Anything usable as a JSX tag — the injected canvas wrapper is a component,
 * not a plain function that gets called.
 *
 * @typedef {import('react').ElementType} FrameComponent
 */

/**
 * The reusable graph-editing surface, shared by the topology console and the
 * debug overlay. Returns a Fragment (no wrapper element) so it drops into the
 * console's existing CSS-grid `topology-app` shell without changing the DOM.
 * It owns three things — the selection, the Delete key, and the per-node rate
 * histories. Everything else is injected: the graph, the command handlers, the
 * canvas `frame`, and the display flags. Selecting a node, an edge or a hull
 * clears the other two, so Delete has one unambiguous target.
 *
 * Part of the selection is the sidecar shown in the selected node's place:
 * an owned node the canvas never draws, opened from its owner's "…" — the
 * card's, or a shown sidecar's own in the Inspector. Any other selection,
 * edit mode, or the owner leaving the graph drops it, and Delete removes
 * nothing while it shows: the selected node is its owner, not what the
 * Inspector shows.
 *
 * @param {Object}                 props
 * @param {Object}                 props.graph                { nodes, edges } to render.
 * @param {FrameComponent}         props.frame                Component wrapping the canvas (CanvasFrame in the console, a plain frame in the overlay). Receives `frameProps` and the canvas as children.
 * @param {Object}                 [props.frameProps]         Props forwarded to `frame`.
 * @param {string}                 props.resetKey             Identity key; a change clears the rate history and both the edge and hull selections.
 * @param {?Object}                [props.viewportDelta]      Persisted `{ dcx, dcy, zoom }` offset from autofit; the canvas applies it once it knows its first autofit box. Null autofits.
 * @param {boolean}                [props.interactive]        Gate for every canvas gesture. Default true.
 * @param {boolean}                [props.editMode]           Draft mode: the Palette gains its topologies, the Inspector becomes the config form, and Delete removes a selected edge or hull. Default false.
 * @param {boolean}                [props.showPalette]        Render the class palette. Default false.
 * @param {boolean}                [props.paletteLoading]     The catalog fetch is in flight; the palette shows a placeholder until classes arrive. Default false.
 * @param {string}                 [props.streamStatus]       SSE state for the Inspector; absent or 'open' reads as live.
 * @param {Function}               [props.onConnect]          (from, to) — a wire was dropped on an IN port. Omitted disables wire drags.
 * @param {Function}               [props.onRemoveNode]       (id)
 * @param {Function}               [props.onRemoveEdge]       (from, to)
 * @param {Function}               [props.onDropNode]         ({ shellName, x, y }) — a palette class dropped on the canvas, x/y already projected into SVG space.
 * @param {Function}               [props.onInspectorAction]  (action, nodeId, value) — every command the Inspector sends but a compose.
 * @param {Function}               [props.onCompose]          (form) — sends the Compose modal's message; returns the refusal, or null once sent.
 * @param {Function}               [props.onRenameNode]       (id, next) — returns false when the name is already taken.
 * @param {Function}               [props.onUpdateArgs]       (id, args) — writes constructor args back to the draft.
 * @param {Function}               [props.onUpdateVerbs]      (id, invocations) — writes verb calls back to the draft.
 * @param {Function}               [props.onSelectionChange]  (selectedId|null) — mirrors the NODE selection outward; null whenever no node is selected.
 * @param {?string}                [props.selection]          Controlled NODE selection, letting a consumer re-point it after a rename or clear it. A non-null value also clears the edge selection; null does not, because null is the node selection's own empty value and exactly what an edge selection leaves behind. The hull selection is never touched. `undefined` leaves GraphView self-controlled.
 * @param {boolean}                [props.inspectorCollapsed] Collapse the inspector to a slim expand-rail. Consumer-owned state, mirroring the palette. Default false.
 * @param {Function}               [props.onInspectorToggle]  () — the collapse/expand chevron was clicked; the consumer flips its own `inspectorCollapsed`.
 * @param {?Set<string>}           [props.driftIds]           Runtime drift, painted distinctly: on a worker, its live nodes outside its registered .tsl; on the browser graph, the nodes the console made (`useGraphReset`'s `userNodeIds`). Null means no drift information.
 * @param {boolean}                [props.local]              The graph is the browser's own, so the no-node header reads wire-accurate IoTelemetry, as the overlay's Overview tab does, instead of rolling up dump_metadata. Default false (remote or worker scope).
 * @param {number}                 [props.debugLevel]         Live Dumper verbosity; the Inspector's no-node Debug toggle lights at 1 and Verbose at 2. Default 0.
 * @param {Array}                  [props.hulls]              One soft hull per include, `{ include, depth, nodeIds }[]`. Forwarded to SchematicCanvas, and the scope `hullNodes` reads for the selected hull's sparklines.
 * @param {string}                 [props.currentTopology]    The topology being edited; the Palette refuses to drag it, or any topology that includes it, onto itself.
 * @param {Function}               [props.onDropTopology]     ({ name, x, y }) — a topology dragged from the Palette onto the canvas.
 * @param {Object}                 [props.includeTree]        `topologies expand`'s `tree`; forwarded to Inspector's IncludeTree as `tree`.
 * @param {string[]}               [props.includes]           The draft's DIRECTLY-declared includes. The Palette greys out entries already included, Inspector gates its IncludeTree rows and the hull panel's remove button on it, and it is what makes a hull deletable here — a hull drawn for a nested include has no line to remove.
 * @param {(name: string) => void} [props.onRemoveInclude]    Removes a declared include; reached from the IncludeTree rows, the hull panel's remove button, and the Delete key on a selected hull.
 * @param {Function}               [props.onOpenTopology]     (name) — drill into a hull's topology (open its .tsl).
 * @return {import('react').ReactElement} The graph-editing surface as a Fragment.
 */
export default function GraphView( {
	graph,
	frame: Frame,
	frameProps = {},
	resetKey,
	viewportDelta = null,
	interactive = true,
	editMode = false,
	showPalette = false,
	paletteLoading = false,
	streamStatus,
	onConnect,
	onRemoveNode,
	onRemoveEdge,
	onDropNode,
	onInspectorAction,
	onCompose,
	onRenameNode,
	onUpdateArgs,
	onUpdateVerbs,
	onSelectionChange,
	selection,
	inspectorCollapsed = false,
	onInspectorToggle,
	driftIds = null,
	local = false,
	debugLevel = 0,
	hulls = [],
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
	// Hover is lifted here so an Inspector node link highlights its card.
	const [ hoveredId, setHoveredId ] = useState( null );
	// The sidecar shown in the selected node's place, or null.
	const [ sidecar, setSidecar ] = useState( null );
	// The open "…" grid: whose it is, what it shows, and what opened it.
	const [ listing, setListing ] = useState( null );
	// The selection as of the last render, for the controlled re-sync.
	const selectedRef = useRef( null );
	selectedRef.current = selectedId;
	const dockRef = useRef( null );

	// Re-sync the NODE selection to an external value (rename re-point).
	useEffect( () => {
		if ( selection === undefined ) {
			return;
		}
		// A consumer echoing the selection back keeps the sidecar on it.
		if ( selection !== selectedRef.current ) {
			setSidecar( null );
		}
		setSelectedId( selection );
		// Only a NODE supersedes an edge; null is the empty node selection.
		if ( null !== selection ) {
			setSelectedEdge( null );
		}
	}, [ selection ] );

	// Identity change (scope / mode / topology): no edge or hull survives it.
	useEffect( () => {
		setSelectedEdge( null );
		setSelectedHull( null );
		setSidecar( null );
	}, [ resetKey ] );

	// A draft has no sidecars to show: edit mode, either way, drops one.
	useEffect( () => {
		setSidecar( null );
		setListing( null );
	}, [ editMode ] );

	const ownerShown = graph.nodes.some( ( n ) => n.id === selectedId );
	// An owner gone from the graph takes its sidecar, and its poll, with it.
	useEffect( () => {
		if ( ! ownerShown ) {
			setSidecar( null );
		}
	}, [ ownerShown ] );
	const shownSidecar = ! editMode && ownerShown ? sidecar : null;
	// One poller asks for the shown sidecar's row and the open grid's owner's.
	const sidecarOwners = useMemo(
		() => [
			...new Set(
				[ shownSidecar, listing?.owner ].filter( ( n ) => !! n )
			),
		],
		[ shownSidecar, listing ]
	);
	const sidecarRows = useSidecarRows( sidecarOwners );
	// The open grid's sidecars, as the owner's live row lists them now.
	const isOwner = ( n ) => n.id === listing?.owner;
	const ownerRow =
		sidecarRows.graph?.nodes.find( isOwner ) ?? graph.nodes.find( isOwner );
	const listed = ( listing && ownerRow?.sidecars ) || [];
	const { rateRef: sidecarRateRef } = useGraphRates(
		sidecarRows.snapshot,
		resetKey
	);

	// @longform A sparkline point is a dump_metadata POLL REPLY, never the
	// canvas graph: an optimistic patch or a catalog republish rebuilds that,
	// and sampling a rebuild files a rate no counter moved to earn.
	const snapshot = usePublishedGraph( 'snapshot' );
	const { rateRef, rateVersion } = useGraphRates( snapshot, resetKey );
	// One derivation for both scopes, off the per-node rate histories.
	const rateSeries = useMemo(
		() => aggregateSeries( rateRef.current, graph.nodes ),
		// rateVersion ticks on every poll; rateRef itself is stable.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[ graph.nodes, rateRef, rateVersion ]
	);
	const hullRateSeries = useMemo(
		() =>
			aggregateSeries(
				rateRef.current,
				hullNodes( graph.nodes, hulls, selectedHull )
			),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[ graph.nodes, hulls, selectedHull, rateRef, rateVersion ]
	);

	// Node + edge selection are mutually exclusive (unambiguous Delete).
	const handleSelectNode = useCallback(
		( id ) => {
			setSelectedId( id );
			setSelectedEdge( null );
			setSelectedHull( null );
			setSidecar( null );
			onSelectionChange?.( id );
		},
		[ onSelectionChange ]
	);
	const handleSelectEdge = useCallback(
		( edge ) => {
			setSelectedEdge( edge );
			setSelectedId( null );
			setSidecar( null );
			// One selection at a time: an edge supersedes a hull.
			setSelectedHull( null );
			onSelectionChange?.( null );
		},
		[ onSelectionChange ]
	);

	// Select an include's hull, from the canvas or a list; clears the rest.
	const selectHull = useCallback(
		( include ) => {
			setSelectedId( null );
			setSelectedEdge( null );
			setSelectedHull( include );
			setSidecar( null );
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
			if ( shownSidecar ) {
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
		shownSidecar,
		selectedEdge,
		selectedHull,
		includes,
		graph.nodes,
		handleRemoveNode,
		handleRemoveEdge,
		handleRemoveHull,
	] );

	const nodeIds = new Set( graph.nodes.map( ( n ) => n.id ) );
	/**
	 * Open a "…" grid, remembering the control that opened it for the focus.
	 *
	 * @param {string}                    owner   Whose sidecars it shows.
	 * @param {?(HTMLElement|SVGElement)} trigger The control that opened it.
	 */
	const openSidecars = ( owner, trigger ) => setListing( { owner, trigger } );
	/**
	 * Show a node: a canvas node by selecting it, an owned one in the selected
	 * node's place.
	 *
	 * @param {string} name The node to show.
	 */
	const openNode = ( name ) => {
		if ( nodeIds.has( name ) ) {
			handleSelectNode( name );
		} else {
			setSidecar( name );
		}
	};
	/**
	 * Show the sidecar chosen from the open grid, selecting its owner first
	 * when the owner is a canvas card, and move focus to the Inspector.
	 *
	 * @param {string} name The sidecar chosen.
	 */
	const pickSidecar = ( name ) => {
		if ( nodeIds.has( listing.owner ) ) {
			handleSelectNode( listing.owner );
		}
		setSidecar( name );
		setListing( null );
		dockRef.current?.focus();
	};
	const dismissSidecars = () => {
		listing.trigger?.focus();
		setListing( null );
	};

	const inspectorToggleLabel = inspectorCollapsed
		? __( 'Expand inspector', 'newspack-nodes' )
		: __( 'Collapse inspector', 'newspack-nodes' );

	return (
		<>
			{ showPalette && (
				<Palette
					editMode={ editMode }
					loading={ paletteLoading }
					onDropNode={ onDropNode }
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
					onSelectHull={ selectHull }
					onDeselect={ () => {
						setSelectedId( null );
						setSelectedEdge( null );
						// The hull is a selection too — background clears it.
						setSelectedHull( null );
						onSelectionChange?.( null );
					} }
					hoveredId={ hoveredId }
					onHover={ setHoveredId }
					rateRef={ rateRef }
					viewportDelta={ viewportDelta }
					interactive={ interactive }
					editMode={ editMode }
					onConnect={ onConnect }
					selectedEdge={ selectedEdge }
					onSelectEdge={ handleSelectEdge }
					onOpenSidecars={ openSidecars }
					hulls={ hulls }
				/>
			</Frame>
			{ /* Always present so the show/hide chevron is reachable with no selection. */ }
			{
				<div
					ref={ dockRef }
					tabIndex={ -1 }
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
							sidecar={ shownSidecar }
							sidecarGraph={
								sidecarRows.answered.includes( shownSidecar )
									? sidecarRows.graph
									: null
							}
							onOpenSidecars={ openSidecars }
							onOpenNode={ openNode }
							parsed={ graph }
							streamStatus={ streamStatus }
							rateInfo={
								( shownSidecar
									? sidecarRateRef.current.get( shownSidecar )
									: rateRef.current.get( selectedId ) ) ??
								null
							}
							rateSeries={ rateSeries }
							hullRateSeries={ hullRateSeries }
							local={ local }
							debugLevel={ debugLevel }
							onAction={ onInspectorAction }
							onCompose={ onCompose }
							onSelect={ handleSelectNode }
							onHover={ setHoveredId }
							nodeIds={ nodeIds }
							editMode={ editMode }
							onUpdateArgs={ onUpdateArgs }
							onUpdateVerbs={ onUpdateVerbs }
							onRemoveNode={ handleRemoveNode }
							onRenameNode={ onRenameNode }
							onRemoveEdge={ handleRemoveEdge }
							onConnect={ onConnect }
							tree={ includeTree }
							includes={ includes }
							selectedHull={ selectedHull }
							hulls={ hulls }
							onOpenTopology={ onOpenTopology }
							onRemoveInclude={ onRemoveInclude }
							onRemoveHull={ handleRemoveHull }
							onSelectHull={ selectHull }
							currentTopology={ currentTopology }
						/>
					) }
				</div>
			}
			{ listing && (
				<SidecarsModal
					owner={ listing.owner }
					sidecars={ listed }
					rows={ sidecarRows.graph?.nodes ?? [] }
					rates={ sidecarRateRef.current }
					onPick={ pickSidecar }
					onDismiss={ dismissSidecars }
				/>
			) }
		</>
	);
}
