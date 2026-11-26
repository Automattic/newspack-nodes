/**
 * The console's graph as the shared ForceGraph takes it: nodes, lines and
 * nested groups, with the classes that say what each one is and what the
 * selection and the hover make of it.
 *
 * What lights is what lights in Tachikoma's visualizer. A node lights while
 * its own rate is above zero; a sink line, while the rate of its source is; a
 * target or a registration line, while the rates of both ends are; a patron
 * line, while the rate of the sidecar is. Port flags play no part.
 *
 * Every node is a circle just wide enough for the message rate it holds,
 * written out whole and grouped, so a poll resizes it only as that text widens
 * or narrows. A draft's nodes hold no rate and take the least radius.
 *
 * Every class, for the console's stylesheet to paint:
 *
 * | On    | Class             | Meaning                                         |
 * |-------|-------------------|-------------------------------------------------|
 * | Node  | `is-idle`         | Live, at rate zero and without focus.           |
 * | Node  | `is-drift`        | Runtime drift.                                  |
 * | Node  | `is-owner`        | A target line leaves it.                        |
 * | Node  | `is-lit`          | In the hull in focus.                           |
 * | Node  | `is-dimmed`       | Another node is hovered, or it is off the hull. |
 * | Line  | `is-target`       | An edge to a target.                            |
 * | Line  | `is-virtual`      | A target that a command argument names.         |
 * | Line  | `is-registration` | An edge to an event's listener.                 |
 * | Line  | `is-sink`         | A node's sink.                                  |
 * | Line  | `is-patron`       | A sidecar and its patron.                       |
 * | Line  | `is-touched`      | Ends at the hovered node, else the selected.    |
 * | Line  | `is-lit`          | Both ends are in the hull in focus.             |
 * | Line  | `is-dimmed`       | The hovered node or the hull in focus lacks it. |
 * | Group | `is-hull-1` … `6` | Its color, as the schematic paints its hull.    |
 *
 * A line wears one of the five kinds. The hull in focus is the hovered one,
 * else the selected one. The component adds `is-live`,
 * `is-selected` and `is-hovered` itself.
 *
 * @typedef {import('@newspack-nodes/shared/forceGraph/ForceGraph').GraphNode} GraphNode
 * @typedef {import('@newspack-nodes/shared/forceGraph/ForceGraph').GraphLink} GraphLink
 * @typedef {import('@newspack-nodes/shared/forceGraph/ForceGraph').GraphGroup} GraphGroup
 */

import { classes } from '@newspack-nodes/shared/components/Modal';
import { LEAST_RADIUS } from '@newspack-nodes/shared/forceGraph';
import { formatGroupedCount } from '@newspack-nodes/shared/utils/formatters';
import names from '../../runtime/reserved-node-names.json';
import { edgeHasConnectRole } from './consoleGraph';
import { hullColorIndex } from './hullColor';

/** Pixels a patron line pulls a sidecar and its patron to. */
const PATRON_DISTANCE = 100;

/** What a sidecar's label is drawn at. */
const SIDECAR_SCALE = 0.8;

/**
 * An include's hull.
 *
 * @typedef {Object} Hull
 * @property {string}   include Its name.
 * @property {number}   depth   Its deepest occurrence in the tree, 1 at the top.
 * @property {string[]} nodeIds The nodes it provides.
 */

/**
 * A node of the console's graph, as far as the force graph reads it.
 *
 * @typedef {Object} Body
 * @property {string}                               id         Its name.
 * @property {string}                               class      Its class.
 * @property {string}                               [sink]     Name of its sink.
 * @property {Array<{name: string, class: string}>} [sidecars] The sidecars it lists.
 */

/**
 * An edge of the console's graph, as far as the force graph reads it.
 *
 * @typedef {Object} Edge
 * @property {string}   from           Source name.
 * @property {string}   to             Target name.
 * @property {boolean}  [registration] Whether the target listens to an event.
 * @property {string}   [event]        The event.
 * @property {boolean}  [virtual]      Whether a command argument names the target.
 * @property {string[]} [roles]        What wires it; absent on a plain connection.
 */

/** @typedef {{nodes: Body[], edges: Edge[]}} ConsoleGraph */

/**
 * The canvas state that classes read.
 *
 * @typedef {Object} CanvasState
 * @property {?string}      selectedId   The selected canvas node.
 * @property {?string}      sidecar      The sidecar shown in its place.
 * @property {?string}      hoveredId    The hovered node.
 * @property {?string}      hoveredHull  The hovered include.
 * @property {?string}      selectedHull The selected include.
 * @property {?Set<string>} driftIds     Drifted nodes; null without drift information.
 * @property {boolean}      editMode     Whether the graph is a draft.
 */

/** @typedef {Map<string, {root: string, owner: string}>} Patrons */

/**
 * The canvas node a drawn node belongs to: for a sidecar, the one at the root
 * of its chain; for any other, itself.
 *
 * @param {Patrons} patronOf Each sidecar's patron.
 * @param {string}  id       The node.
 * @return {string} The canvas node.
 */
const rootOf = ( patronOf, id ) => patronOf.get( id )?.root ?? id;

/**
 * The hulls' places in the include tree. A parent is taken only at its own
 * deepest occurrence, so it lies shallower than its child and no chain of
 * parents can close.
 *
 * @param {Hull[]} hulls The hulls.
 * @param {Object} tree  The include tree, `{ name: subtree }`.
 * @return {{parentOf: Map<string, ?string>, rankOf: Map<string, number>}} The hull around each, and the order the tree first names them in.
 */
const placesOf = ( hulls, tree ) => {
	const depthOf = new Map( hulls.map( ( h ) => [ h.include, h.depth ] ) );
	const parentOf = new Map();
	const rankOf = new Map();
	const walk = ( level, depth, parent ) => {
		for ( const [ name, subtree ] of Object.entries( level ) ) {
			const isDeepest = depthOf.get( name ) === depth;
			if ( ! rankOf.has( name ) ) {
				rankOf.set( name, rankOf.size );
			}
			if ( isDeepest && ! parentOf.has( name ) ) {
				parentOf.set( name, parent );
			}
			walk( subtree, depth + 1, isDeepest ? name : parent );
		}
	};
	walk( tree, 1, null );
	return { parentOf, rankOf };
};

/**
 * The hulls as groups.
 *
 * @param {Hull[]}               hulls    The hulls.
 * @param {Map<string, ?string>} parentOf The hull around each.
 * @return {GraphGroup[]} One group for each hull, in order.
 */
const groupsUnder = ( hulls, parentOf ) =>
	hulls.map( ( { include } ) => ( {
		id: include,
		label: include,
		parent: parentOf.get( include ),
		className: `is-hull-${ 1 + hullColorIndex( include ) }`,
	} ) );

/**
 * The include each node sits in: its deepest, and of several at one depth the
 * first the tree names.
 *
 * @param {Hull[]}              hulls  The hulls.
 * @param {Map<string, number>} rankOf The order the tree names them in.
 * @return {Map<string, string>} Include by node.
 */
const seatsOf = ( hulls, rankOf ) => {
	const seats = new Map();
	const innermostLast = [ ...hulls ].sort(
		( a, b ) =>
			a.depth - b.depth ||
			rankOf.get( b.include ) - rankOf.get( a.include )
	);
	for ( const { include, nodeIds } of innermostLast ) {
		nodeIds.forEach( ( id ) => seats.set( id, include ) );
	}
	return seats;
};

/**
 * The graph's nodes, then every sidecar they list at any depth, then with
 * `showSinks` the interpreter nearly every node sinks into, which the layout
 * holds at the centre of the canvas.
 *
 * @param {Body[]}  nodes     The graph's nodes.
 * @param {?Body[]} rows      The polled rows; null draws the graph's nodes alone.
 * @param {boolean} showSinks Whether sinks are drawn.
 * @return {{bodies: Map<string, Body>, patronOf: Patrons}} Nodes by name, and for each sidecar the node owning it and the canvas node at the root of its chain.
 */
const bodiesOf = ( nodes, rows, showSinks ) => {
	const bodies = new Map( nodes.map( ( node ) => [ node.id, node ] ) );
	const patronOf = new Map();
	if ( ! rows ) {
		return { bodies, patronOf };
	}
	const rowOf = new Map( rows.map( ( row ) => [ row.id, row ] ) );
	// A Map iterates what the walk adds, each once: breadth first.
	for ( const [ owner, body ] of bodies ) {
		const { sidecars = [] } = rowOf.get( owner ) ?? body;
		const root = rootOf( patronOf, owner );
		for ( const { name, class: shellName } of sidecars ) {
			if ( ! bodies.has( name ) ) {
				const unpolled = { id: name, class: shellName };
				bodies.set( name, rowOf.get( name ) ?? unpolled );
				patronOf.set( name, { root, owner } );
			}
		}
	}
	const interpreter = rowOf.get( names.COMMAND_INTERPRETER );
	if ( showSinks && interpreter ) {
		bodies.set( interpreter.id, interpreter );
	}
	return { bodies, patronOf };
};

/**
 * An edge's ends in one key. A node name cannot hold a `/`.
 *
 * @param {Edge} edge The edge.
 * @return {string} `<from>/<to>`.
 */
const pathOf = ( { from, to } ) => `${ from }/${ to }`;

/**
 * The id of the line an edge to a target draws.
 *
 * @param {Edge} edge The edge.
 * @return {string} The id.
 */
export const targetLinkId = ( edge ) => `target:${ pathOf( edge ) }`;

/**
 * The pairs a connection joins, and those whose target a command argument
 * names. A pair in both draws the line of its connection.
 *
 * @param {Edge[]} edges The edges drawn.
 * @return {{connected: Set<string>, named: Set<string>}} Their paths.
 */
const pairsOf = ( edges ) => {
	const connected = new Set();
	const named = new Set();
	for ( const edge of edges ) {
		if ( edge.virtual ) {
			named.add( pathOf( edge ) );
		} else if ( ! edge.registration && edgeHasConnectRole( edge ) ) {
			connected.add( pathOf( edge ) );
		}
	}
	return { connected, named };
};

/**
 * A rate written out whole and grouped; one under half a message reads
 * `<1/s`, never `0/s`, so a live node's text still says it has traffic.
 *
 * @param {number} rate Messages per second.
 * @return {string} The rate's text.
 */
const rateText = ( rate ) =>
	rate > 0 && rate < 0.5
		? '<1/s'
		: `${ formatGroupedCount( Math.round( rate ) ) }/s`;

/**
 * What the state makes of a node and of a line.
 *
 * @param {CanvasState}                          state    The canvas state.
 * @param {Hull[]}                               hulls    The hulls.
 * @param {Patrons}                              patronOf Each sidecar's patron.
 * @param {function(string): (number|undefined)} rateOf   A node's rate, undefined in a draft.
 * @return {{node: function(string): string, line: function(string, string, string): string}} Their classes.
 */
const classesUnder = ( state, hulls, patronOf, rateOf ) => {
	const { selectedId, hoveredId, driftIds } = state;
	const focused = state.hoveredHull ?? state.selectedHull;
	const hull = hulls.find( ( { include } ) => include === focused );
	const members = hull && new Set( hull.nodeIds );
	const isLit = ( id ) => !! members?.has( rootOf( patronOf, id ) );
	const touchedBy = hoveredId ?? selectedId;
	const isDimmed = ( hovered, lit ) =>
		( !! hoveredId && ! hovered ) || ( !! hull && ! lit );

	return {
		node: ( id ) => {
			const lit = isLit( id );
			const hovered = id === hoveredId;
			const hasFocus = lit || hovered || id === selectedId;
			return classes(
				0 === rateOf( id ) && ! hasFocus && 'is-idle',
				driftIds?.has( id ) && 'is-drift',
				lit && 'is-lit',
				isDimmed( hovered, lit ) && 'is-dimmed'
			);
		},
		line: ( kind, source, target ) => {
			const lit = isLit( source ) && isLit( target );
			const touched = source === touchedBy || target === touchedBy;
			return classes(
				`is-${ kind }`,
				touched && 'is-touched',
				lit && 'is-lit',
				isDimmed( touched, lit ) && 'is-dimmed'
			);
		},
	};
};

/**
 * Where the hulls stand: the includes as groups, each nested under the include
 * around its deepest occurrence, skipping one without a hull, and the include
 * each node sits in.
 *
 * @param {Hull[]} hulls The hulls.
 * @param {Object} tree  The include tree, `{ name: subtree }`.
 * @return {{groups: GraphGroup[], seats: Map<string, string>}} One group for each hull, in order, and include by node.
 */
export const placeHulls = ( hulls, tree ) => {
	const { parentOf, rankOf } = placesOf( hulls, tree );
	return {
		groups: groupsUnder( hulls, parentOf ),
		seats: seatsOf( hulls, rankOf ),
	};
};

/**
 * The console's graph, for the ForceGraph.
 *
 * An edge between a sidecar and its patron folds into their patron line,
 * which takes its direction, and of a registration the event. Edges that
 * collapse on one pair draw one line, virtual where the pair is not connected.
 * The line of a connection alone takes a press.
 *
 * @param {Object}                   options           What to draw.
 * @param {ConsoleGraph}             options.graph     The graph on the canvas.
 * @param {?ConsoleGraph}            options.rows      The `dump_metadata -s` graph, or null before it answers.
 * @param {Hull[]}                   options.hulls     The hulls.
 * @param {Map<string, string>}      options.seats     The include each node sits in, as `placeHulls` answers.
 * @param {boolean}                  options.showSinks Whether to draw sinks.
 * @param {function(string): number} options.rateOf    A node's messages a second.
 * @param {CanvasState}              options.state     The canvas state.
 * @return {{nodes: GraphNode[], links: GraphLink[], patronOf: Patrons, selectedId: ?string}} The props, each sidecar's patron, and what is selected: the sidecar shown when it is drawn, else the canvas node.
 */
export const toForceGraph = ( {
	graph,
	rows,
	hulls,
	seats,
	showSinks,
	rateOf,
	state,
} ) => {
	const polled = state.editMode ? null : rows;
	const liveRate = state.editMode ? () => undefined : rateOf;
	const { bodies, patronOf } = bodiesOf(
		graph.nodes,
		polled?.nodes,
		showSinks
	);
	// The graph holds the edges of its own nodes, so the rows add the rest.
	const edges = graph.edges.concat(
		( polled?.edges ?? [] ).filter(
			( { from } ) =>
				patronOf.has( from ) || names.COMMAND_INTERPRETER === from
		)
	);
	const { connected, named } = pairsOf( edges );
	const selectedId = bodies.has( state.sidecar )
		? state.sidecar
		: state.selectedId;
	const classOf = classesUnder(
		{ ...state, selectedId },
		hulls,
		patronOf,
		liveRate
	);

	const links = new Map();
	// A node a target line leaves owns it, as the visualizer colors one.
	const owners = new Set();
	const draw = ( id, kind, source, target, rest ) => {
		if (
			bodies.has( source ) &&
			bodies.has( target ) &&
			! links.has( id )
		) {
			const className = classOf.line( kind, source, target );
			links.set( id, {
				id,
				source,
				target,
				className,
				pressable: false,
				...rest,
			} );
		}
	};
	const drawPatron = ( sidecar, source, target, directed ) =>
		draw( `patron:${ sidecar }`, 'patron', source, target, {
			rate: liveRate( sidecar ),
			directed,
			distance: PATRON_DISTANCE,
		} );
	const eventsOf = new Map();
	const fold = ( sidecar, /** @type {Edge} */ edge ) => {
		const { from, to, event } = edge;
		drawPatron( sidecar, from, to, true );
		const line = links.get( `patron:${ sidecar }` );
		if ( event ) {
			const events = eventsOf.get( sidecar ) ?? new Set();
			eventsOf.set( sidecar, events.add( event ) );
			line.title = [ ...events ].join( ', ' );
		}
	};
	const owns = ( owner, id ) => patronOf.get( id )?.owner === owner;
	/** @param {Edge} edge The edge to draw. */
	const drawEdge = ( edge ) => {
		const { from, to, registration, event } = edge;
		const rate = 0 === liveRate( to ) ? 0 : liveRate( from );
		const path = pathOf( edge );
		if ( owns( to, from ) ) {
			fold( from, edge );
		} else if ( owns( from, to ) ) {
			fold( to, edge );
		} else if ( registration ) {
			draw(
				`registration:${ path }/${ event }`,
				'registration',
				from,
				to,
				{
					rate,
					directed: true,
					title: event,
				}
			);
		} else {
			const pressable = connected.has( path );
			const isVirtual = ! pressable && named.has( path );
			const kind = isVirtual ? 'virtual' : 'target';
			owners.add( from );
			draw( targetLinkId( edge ), kind, from, to, {
				rate,
				directed: true,
				curved: true,
				pressable,
			} );
		}
	};

	edges.forEach( drawEdge );
	for ( const [ sidecar, { owner } ] of patronOf ) {
		drawPatron( sidecar, sidecar, owner, false );
	}
	if ( showSinks ) {
		for ( const { id, sink } of bodies.values() ) {
			draw( `sink:${ id }/${ sink }`, 'sink', id, sink, {
				rate: liveRate( id ),
				directed: true,
				loose: true,
			} );
		}
	}

	const drawn = [ ...bodies.values() ].map( ( body ) => {
		const rate = liveRate( body.id );
		const detail = undefined === rate ? undefined : rateText( rate );
		return { ...body, rate, detail };
	} );

	return {
		nodes: drawn.map( ( { id, class: shellName, rate, detail } ) => ( {
			id,
			label: id,
			title: shellName,
			group: seats.get( rootOf( patronOf, id ) ),
			className: classes(
				classOf.node( id ),
				owners.has( id ) && 'is-owner'
			),
			rate,
			// The shared graph widens a circle to hold its detail.
			size: LEAST_RADIUS,
			detail,
			scale: patronOf.has( id ) ? SIDECAR_SCALE : 1,
			center: names.COMMAND_INTERPRETER === id,
		} ) ),
		links: [ ...links.values() ],
		patronOf,
		selectedId,
	};
};
