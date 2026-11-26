import { useMemo, useRef, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { ForceGraph } from '@newspack-nodes/shared/forceGraph';
import { useForceRows } from '../hooks/useForceRows';
import { useGraphRates } from '../hooks/useGraphRates';
import { useChrome } from '../ChromeContext';
import {
	placeHulls,
	targetLinkId,
	toForceGraph,
} from '../utils/forceGraphModel';
import names from '../../runtime/reserved-node-names.json';

/** @typedef {import('../utils/forceGraphModel').ConsoleGraph} ConsoleGraph */
/** @typedef {import('../utils/forceGraphModel').Hull} Hull */
/** @typedef {import('../hooks/useGraphRates').RateEntry} RateEntry */

/**
 * Whether two flat records hold the same fields.
 *
 * @param {Object} one A record.
 * @param {Object} two Another.
 * @return {boolean} True when they read the same.
 */
const isSame = ( one, two ) => {
	const fields = Object.keys( one );
	return (
		fields.length === Object.keys( two ).length &&
		fields.every( ( field ) => one[ field ] === two[ field ] )
	);
};

/**
 * A list of flat records under one identity for as long as it reads the same,
 * which is what the ForceGraph takes for no change.
 *
 * @template {Object} T
 * @param {T[]} list The list as it now is.
 * @return {T[]} It, or the list handed back before it while the two read the same.
 */
const useKept = ( list ) => {
	const kept = useRef( list );
	if (
		list.length !== kept.current.length ||
		! list.every( ( one, i ) => isSame( one, kept.current[ i ] ) )
	) {
		kept.current = list;
	}
	return kept.current;
};

/**
 * ForceCanvas — the console's second canvas: the graph GraphView holds, laid
 * out by force, its includes as hulls and every sidecar joined to its patron.
 * It takes what the schematic takes, less what wires nodes and opens grids,
 * and polls the sidecars itself, so the graph GraphView holds never gains one.
 *
 * A full layout comes with a change of scope, with the first snapshot of a
 * seed, and with the first answer about the sidecars.
 *
 * @param {Object}                                     props
 * @param {ConsoleGraph}                               props.parsed        The graph to draw.
 * @param {boolean}                                    props.seeded        Whether it is the seed, with no snapshot yet to sample or to ask about sidecars.
 * @param {?Set<string>}                               props.driftIds      Runtime drift; null without drift information.
 * @param {?string}                                    props.selectedId    Id of the selected canvas node.
 * @param {?string}                                    props.sidecar       The sidecar shown in its place.
 * @param {(id: string) => void}                       props.onSelect      Takes a pressed canvas node.
 * @param {(root: string, name: string) => void}       props.onPickSidecar Takes a pressed sidecar, and the canvas node at the root of its chain.
 * @param {() => void}                                 props.onDeselect    Runs on a press of the canvas, on Escape, and on the interpreter, whose panel is the no-node one.
 * @param {?string}                                    props.hoveredId     Id of the hovered node.
 * @param {(id: ?string) => void}                      props.onHover       Takes the node the pointer is over, or null.
 * @param {?{from: string, to: string}}                props.selectedEdge  The selected edge.
 * @param {(edge: {from: string, to: string}) => void} props.onSelectEdge  Takes a pressed connection; edit mode only.
 * @param {?string}                                    props.selectedHull  The selected include.
 * @param {(include: string) => void}                  props.onSelectHull  Takes a pressed hull.
 * @param {Hull[]}                                     props.hulls         One hull per include.
 * @param {Object}                                     props.tree          The include tree, `{ name: subtree }`.
 * @param {string}                                     props.resetKey      Identity of the scope shown.
 * @param {boolean}                                    props.editMode      Whether the graph is a draft: no sidecars, no rates, and edges to select.
 * @param {boolean}                                    props.showSinks     Whether to draw sinks, and the interpreter nearly every node sinks into.
 * @param {boolean}                                    props.keepWarm      Whether a live layout keeps moving.
 * @param {() => void}                                 props.onKeepWarm    Runs on `k`.
 * @param {{current: Map<string, RateEntry>}}          props.rateRef       The canvas nodes' rates.
 * @param {number}                                     props.rateVersion   Ticks with each poll of them.
 * @param {{current: ?SVGSVGElement}}                  [props.svgRef]      Takes the canvas `<svg>`, for a host that asks whether an event landed on it.
 * @return {import('react').ReactElement} The canvas `<svg>`.
 */
export default function ForceCanvas( {
	parsed,
	seeded,
	driftIds,
	selectedId,
	sidecar,
	onSelect,
	onPickSidecar,
	onDeselect,
	hoveredId,
	onHover,
	selectedEdge,
	onSelectEdge,
	selectedHull,
	onSelectHull,
	hulls,
	tree,
	resetKey,
	editMode,
	showSinks,
	keepWarm,
	onKeepWarm,
	rateRef,
	rateVersion,
	svgRef,
} ) {
	const [ hoveredHull, setHoveredHull ] = useState( null );
	const { bottomObstructionPx } = useChrome();
	const isSnapshot = ! editMode && ! seeded;
	const { rows, snapshot } = useForceRows( isSnapshot, resetKey );
	const { rateRef: rowRateRef } = useGraphRates( snapshot, resetKey );

	const { groups, seats } = useMemo(
		() => placeHulls( hulls, tree ),
		[ hulls, tree ]
	);
	const {
		nodes,
		links,
		patronOf,
		selectedId: shownId,
	} = useMemo(
		() =>
			toForceGraph( {
				graph: parsed,
				rows,
				hulls,
				seats,
				showSinks,
				rateOf: ( id ) =>
					(
						rateRef.current.get( id ) ??
						rowRateRef.current.get( id )
					)?.rate ?? 0,
				state: {
					selectedId,
					sidecar,
					hoveredId,
					hoveredHull,
					selectedHull,
					driftIds,
					editMode,
				},
			} ),
		// Stable refs: `rateVersion` ticks, and `rows` is new, with each poll.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[
			parsed,
			rows,
			hulls,
			seats,
			showSinks,
			rateRef,
			rateVersion,
			selectedId,
			sidecar,
			hoveredId,
			hoveredHull,
			selectedHull,
			driftIds,
			editMode,
		]
	);

	/** @param {string} id The pressed node, or the one an arrow reached. */
	const select = ( id ) => {
		const patron = patronOf.get( id );
		if ( patron ) {
			onPickSidecar( patron.root, id );
		} else if ( names.COMMAND_INTERPRETER === id ) {
			onDeselect();
		} else {
			onSelect( id );
		}
	};

	/** @param {{source: string, target: string}} link The pressed line. */
	const selectEdge = ( { source, target } ) =>
		onSelectEdge( { from: source, to: target } );

	return (
		<ForceGraph
			className="topology-force-canvas"
			ariaLabel={ __( 'Topology canvas', 'newspack-nodes' ) }
			svgRef={ svgRef }
			nodes={ useKept( nodes ) }
			links={ useKept( links ) }
			groups={ useKept( groups ) }
			layoutKey={ `${ resetKey }|${ isSnapshot }|${ null !== rows }` }
			pollKey={ rateVersion }
			live={ ! editMode }
			keepWarm={ keepWarm }
			onKeepWarm={ onKeepWarm }
			selectedId={ shownId }
			selectedLink={ selectedEdge && targetLinkId( selectedEdge ) }
			selectedGroup={ selectedHull }
			hoveredId={ hoveredId }
			onSelect={ select }
			onSelectLink={ editMode ? selectEdge : undefined }
			onSelectGroup={ onSelectHull }
			onHover={ onHover }
			onHoverGroup={ setHoveredHull }
			onDeselect={ onDeselect }
			bottomInset={ bottomObstructionPx }
		/>
	);
}
