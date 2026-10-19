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
import SidecarsPopover from './SidecarsPopover';
import { useGraphRates } from '../hooks/useGraphRates';
import { useSidecarRows } from '../hooks/useSidecarRows';
import { usePublishedGraph } from '../hooks/useGraphSource';
import { hullNodes } from '../utils/hullNodes';
import { aggregateSeries } from '../utils/aggregateSeries';

/** An empty list with one identity, so an absent one redraws nothing. */
const NONE = [];

/** A rows map with nothing in it, one identity. */
const NO_ROWS = new Map();

/**
 * The open grids up to a depth, the shared empty list when none is left.
 *
 * @param {string[]} open  The owners of the open grids, outermost first.
 * @param {number}   depth How many to keep.
 * @return {string[]} The ones kept.
 */
function upTo( open, depth ) {
	return depth > 0 ? open.slice( 0, depth ) : NONE;
}

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
 * an owned node the canvas never draws, picked from the grid its owner's "…"
 * opens on the canvas below the owner's card. A grid card owning sidecars in
 * turn opens theirs inside it, below that card, so the open grids form a stack,
 * outermost first. A pick leaves every grid open. Another selection closes
 * them, as does a click off the canvas, unless it lands in the Inspector while
 * that shows a sidecar they list; Esc closes them one at a time, focus on the
 * canvas. While a grid is open the canvas's keys act on its active card: the
 * shown sidecar where the innermost grid lists it, else that grid's first.
 * Enter opens a grid and never closes one; a "…" toggles its own. Another
 * selection, edit mode, or the owner leaving the graph also drops the sidecar,
 * and Delete removes nothing while it shows: the selected node is its owner,
 * not what the Inspector shows.
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
 * @param {boolean}                [props.local]              The graph belongs to the browser, so the no-node header reads wire-accurate IoTelemetry, as the overlay's Overview tab does, instead of rolling up dump_metadata. Default false (remote or worker scope).
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
	// The owners of the open "…" grids, outermost first.
	const [ stack, setStack ] = useState( NONE );
	// The owner whose grid the keys opened last, so it opens on screen.
	const [ entered, setEntered ] = useState( null );
	// The selection as of the last render, for the controlled re-sync.
	const selectedRef = useRef( null );
	selectedRef.current = selectedId;
	const dockRef = useRef( null );
	const canvasRef = useRef( null );

	// Re-sync the NODE selection to an external value (rename re-point).
	useEffect( () => {
		if ( selection === undefined ) {
			return;
		}
		// A consumer echoing the selection back keeps the sidecar on it.
		if ( selection !== selectedRef.current ) {
			setSidecar( null );
			// Another selection closes the grids, but not their own owner's.
			setStack( ( open ) => ( open[ 0 ] === selection ? open : NONE ) );
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
		setStack( NONE );
	}, [ resetKey ] );

	// A draft has no sidecars to show: edit mode, either way, drops one.
	useEffect( () => {
		setSidecar( null );
		setStack( NONE );
	}, [ editMode ] );

	const nodeIds = useMemo(
		() => new Set( graph.nodes.map( ( n ) => n.id ) ),
		[ graph.nodes ]
	);
	const ownerShown = nodeIds.has( selectedId );
	// An owner gone from the graph takes its sidecar, and its poll, with it.
	useEffect( () => {
		if ( ! ownerShown ) {
			setSidecar( null );
		}
	}, [ ownerShown ] );
	const shownSidecar = ! editMode && ownerShown ? sidecar : null;
	// The grids hang from a canvas card, so none outlives it.
	const rooted = useMemo(
		() => ( nodeIds.has( stack[ 0 ] ) ? stack : NONE ),
		[ nodeIds, stack ]
	);
	// One poller asks for the shown sidecar's row and every open grid owner's.
	const sidecarOwners = useMemo(
		() => [
			...new Set( [ shownSidecar, ...rooted ].filter( ( n ) => !! n ) ),
		],
		[ shownSidecar, rooted ]
	);
	const sidecarRows = useSidecarRows( sidecarOwners );
	const gridsAsked = rooted.length > 0;
	// The polled rows by id, while a grid asks for them.
	const rowById = useMemo(
		() =>
			gridsAsked
				? new Map(
						( sidecarRows.graph?.nodes ?? NONE ).map( ( n ) => [
							n.id,
							n,
						] )
				  )
				: NO_ROWS,
		[ gridsAsked, sidecarRows.graph ]
	);
	// The outermost owner's canvas row, its sidecars until its poll answers.
	const rootRow = useMemo(
		() =>
			gridsAsked
				? graph.nodes.find( ( n ) => n.id === rooted[ 0 ] )
				: undefined,
		[ gridsAsked, graph.nodes, rooted ]
	);
	/**
	 * A grid owner's sidecars, as its live row lists them now: its polled row,
	 * or for the outermost owner alone, its canvas row before that answers.
	 *
	 * @param {string} owner The grid's owner.
	 * @return {Array<{name: string, class: string}>} Its sidecars.
	 */
	const sidecarsOf = useCallback(
		( owner ) => {
			// A polled row answers alone; one listing none omits the key.
			const row = rowById.has( owner )
				? rowById.get( owner )
				: owner === rootRow?.id && rootRow;
			return row?.sidecars ?? NONE;
		},
		[ rowById, rootRow ]
	);
	/**
	 * Whether an owner's live row lists a sidecar.
	 *
	 * @param {string} owner The owner.
	 * @param {string} name  The sidecar.
	 * @return {boolean} It does.
	 */
	const lists = useCallback(
		( owner, name ) => sidecarsOf( owner ).some( ( c ) => c.name === name ),
		[ sidecarsOf ]
	);
	// @longform A grid stands only while its owner lists sidecars and the grid
	// it opened from still lists its owner.
	const grids = useMemo( () => {
		const gone = rooted.findIndex(
			( owner, depth ) =>
				0 === sidecarsOf( owner ).length ||
				( depth > 0 && ! lists( rooted[ depth - 1 ], owner ) )
		);
		return gone < 0 ? rooted : upTo( rooted, gone );
	}, [ rooted, sidecarsOf, lists ] );
	// What no grid shows is closed, so it cannot come back when its row does.
	useEffect( () => {
		if ( grids !== stack ) {
			setStack( grids );
		}
	}, [ grids, stack ] );
	const gridOwner = grids[ 0 ];
	const rootSidecars = gridOwner ? sidecarsOf( gridOwner ) : NONE;
	const innermost = grids.at( -1 );
	let gridActive = null;
	if ( innermost ) {
		gridActive = lists( innermost, shownSidecar )
			? shownSidecar
			: sidecarsOf( innermost )[ 0 ]?.name ?? null;
	}
	// An Inspector click keeps the grids while it shows a sidecar they list.
	const showsGridSidecar =
		!! shownSidecar &&
		grids.some( ( owner ) => lists( owner, shownSidecar ) );
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
	const selectNode = useCallback(
		( id ) => {
			setSelectedId( id );
			setSelectedEdge( null );
			setSelectedHull( null );
			setSidecar( null );
			onSelectionChange?.( id );
		},
		[ onSelectionChange ]
	);
	// Every selection but a pick from a grid closes the grids.
	const handleSelectNode = useCallback(
		( id ) => {
			selectNode( id );
			setStack( NONE );
		},
		[ selectNode ]
	);
	const handleSelectEdge = useCallback(
		( edge ) => {
			setSelectedEdge( edge );
			setSelectedId( null );
			setSidecar( null );
			setStack( NONE );
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
			setStack( NONE );
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

	// @longform Delete/Backspace removes the selection (skipped in form fields)
	// and Esc closes a grid. It hears a key last, on the window, so a dialog or
	// field that takes the key first marks it handled and the key stops here.
	useEffect( () => {
		const onKey = ( e ) => {
			if (
				e.defaultPrevented ||
				( e.key !== 'Delete' &&
					e.key !== 'Backspace' &&
					e.key !== 'Escape' )
			) {
				return;
			}
			const tag = e.target && e.target.tagName;
			if ( tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ) {
				return;
			}
			if ( e.target && e.target.isContentEditable ) {
				return;
			}
			// Esc closes the innermost grid, focus back on the canvas.
			if ( 'Escape' === e.key ) {
				if ( grids.length > 0 ) {
					e.preventDefault();
					canvasRef.current?.focus( { preventScroll: true } );
					setStack( upTo( grids, grids.length - 1 ) );
				}
				return;
			}
			// A grid or a dialog owns its keys; the selection never gets them.
			if (
				shownSidecar ||
				( grids.length > 0 && e.target === canvasRef.current ) ||
				e.target?.closest?.( '[role="dialog"], .topology-modal' )
			) {
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
		window.addEventListener( 'keydown', onKey );
		return () => window.removeEventListener( 'keydown', onKey );
	}, [
		grids,
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

	// @longform A press off the canvas, which answers its own, closes the grids,
	// decided as it lands, in the capture phase: before a dialog it dismisses
	// unmounts, and before a control that stops it can hide it.
	const gridsOpen = grids.length > 0;
	useEffect( () => {
		if ( ! gridsOpen ) {
			return undefined;
		}
		const onPress = ( e ) => {
			const inInspector =
				dockRef.current?.contains( e.target ) ||
				!! e.target.closest?.(
					'.topology-modal, .topology-modal-backdrop'
				);
			const keep =
				canvasRef.current?.contains( e.target ) ||
				( showsGridSidecar && inInspector );
			if ( ! keep ) {
				setStack( NONE );
			}
		};
		document.addEventListener( 'mousedown', onPress, true );
		return () => document.removeEventListener( 'mousedown', onPress, true );
	}, [ gridsOpen, showsGridSidecar ] );
	/**
	 * Open a "…" grid at a depth of the stack, closing any open deeper, or
	 * close it when its own "…" is pressed again.
	 *
	 * @param {number} depth 0 for a canvas card's grid, one more per grid.
	 * @param {string} owner Whose sidecars it shows.
	 */
	const openSidecars = useCallback( ( depth, owner ) => {
		setEntered( null );
		setStack( ( open ) =>
			open[ depth ] === owner
				? upTo( open, depth )
				: [ ...open.slice( 0, depth ), owner ]
		);
	}, [] );
	/**
	 * Open a grid from Enter, as `openSidecars` does, but never close it.
	 *
	 * @param {number} depth 0 for a canvas card's grid, one more per grid.
	 * @param {string} owner Whose sidecars it shows.
	 */
	const enterSidecars = useCallback( ( depth, owner ) => {
		setEntered( owner );
		setStack( ( open ) =>
			open[ depth ] === owner
				? open
				: [ ...open.slice( 0, depth ), owner ]
		);
	}, [] );
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
	 * Show the sidecar chosen from an open grid, selecting the canvas card
	 * the grids hang from first. Every grid stays open.
	 *
	 * @param {string} name The sidecar chosen.
	 */
	const pickSidecar = useCallback(
		( name ) => {
			selectNode( gridOwner );
			setSidecar( name );
		},
		[ selectNode, gridOwner ]
	);
	/**
	 * The open grids on the canvas, the outermost below its owner's card,
	 * each drawing the one opened inside it. The canvas answers the owner's
	 * box even while it culls the card just off-screen, so the grids keep
	 * drawing and pan back in with it.
	 *
	 * @param {import('./SchematicCanvas').CanvasOverlayArgs} canvas Where the canvas draws.
	 * @return {?import('react').ReactElement} The outermost popover, or null while the canvas has no box for its owner.
	 */
	const drawGrids = useCallback(
		( { positionOf, surface, showDetail, reveal } ) => {
			const anchor = positionOf( gridOwner );
			return (
				anchor && (
					<SidecarsPopover
						key={ gridOwner }
						owners={ grids }
						depth={ 0 }
						anchor={ anchor }
						sidecars={ rootSidecars }
						rows={ rowById }
						rates={ sidecarRateRef.current }
						surface={ surface }
						showDetail={ showDetail }
						shown={ shownSidecar }
						active={ gridActive }
						entered={ entered }
						onPick={ pickSidecar }
						onOpen={ openSidecars }
						onEnter={ enterSidecars }
						onReveal={ reveal }
					/>
				)
			);
		},
		[
			gridOwner,
			grids,
			rootSidecars,
			rowById,
			sidecarRateRef,
			shownSidecar,
			gridActive,
			entered,
			pickSidecar,
			openSidecars,
			enterSidecars,
		]
	);

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
						setStack( NONE );
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
					svgRef={ canvasRef }
					onOpenSidecars={ ( owner ) => openSidecars( 0, owner ) }
					onEnterSidecars={ ( owner ) => enterSidecars( 0, owner ) }
					overlay={ grids.length > 0 ? drawGrids : undefined }
					overlayActive={ gridActive }
					hulls={ hulls }
				/>
			</Frame>
			{ /* Always present so the show/hide chevron is reachable with no selection. */ }
			{
				<div
					ref={ dockRef }
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
		</>
	);
}
