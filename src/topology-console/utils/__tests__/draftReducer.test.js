/**
 * draftReducer — the draft document as a reducer whose action types ARE the
 * TSL verbs. Every case routes to the matching pure `draftGraph` function; the
 * reducer owns naming and routing, nothing else.
 *
 * Actions are named for the grammar, not the JS helpers, so promoting this to a
 * `Draft_Node` later is a substrate swap rather than a redesign.
 */

import { draftReducer, revertIncludes, DRAFT_ACTIONS } from '../draftReducer';
import {
	addNode,
	removeNode,
	addInclude,
	removeInclude,
	removeEdge,
	connectDraftEdge,
	updateNodeArgs,
	updateNodeVerbs,
} from '../draftGraph';

const EMPTY = { nodes: [], edges: [], frontmatter: {} };

describe( 'draftReducer', () => {
	test( 'every action type is a TSL verb or a declared exception', () => {
		// The claim the spec rests on. If a new action lands that is neither a
		// verb nor listed as an exception, this fails and forces the decision.
		const TSL_VERBS = [
			'make_node',
			'remove_node',
			'connect_node',
			'disconnect_node',
			'move_node',
			'set_arguments',
			'cmd',
			'include',
			'var',
			'secure',
		];
		const EDITOR_ONLY = [ 'remove_include' ];

		for ( const type of DRAFT_ACTIONS ) {
			expect( [ ...TSL_VERBS, ...EDITOR_ONLY ] ).toContain( type );
		}
	} );

	test( 'make_node routes to addNode', () => {
		const action = {
			type: 'make_node',
			shellName: 'Tee',
			name: 'wombat-tee',
			x: 10,
			y: 20,
		};

		expect( draftReducer( EMPTY, action ) ).toEqual(
			addNode( EMPTY, {
				shellName: 'Tee',
				name: 'wombat-tee',
				x: 10,
				y: 20,
			} )
		);
	} );

	test( 'remove_node routes to removeNode', () => {
		const seeded = addNode( EMPTY, {
			shellName: 'Tee',
			name: 'doomed-tee',
			x: 0,
			y: 0,
		} );
		const id = seeded.nodes[ 0 ].id;

		expect( draftReducer( seeded, { type: 'remove_node', id } ) ).toEqual(
			removeNode( seeded, id )
		);
	} );

	test( 'move_node routes to moveNode — the verb Slice 0 ported', () => {
		const seeded = addNode( EMPTY, {
			shellName: 'Tee',
			name: 'before-move',
			x: 0,
			y: 0,
		} );
		const id = seeded.nodes[ 0 ].id;

		const moved = draftReducer( seeded, {
			type: 'move_node',
			id,
			newName: 'after-move',
		} );

		expect( moved.nodes[ 0 ].name ).toBe( 'after-move' );
	} );

	test( 'include routes to addInclude', () => {
		expect(
			draftReducer( EMPTY, { type: 'include', name: 'topic-probe' } )
		).toEqual( addInclude( EMPTY, 'topic-probe' ) );
	} );

	test( 'var replaces frontmatter wholesale', () => {
		const next = draftReducer( EMPTY, {
			type: 'var',
			frontmatter: { num_partitions: 4 },
		} );

		expect( next.frontmatter ).toEqual( { num_partitions: 4 } );
		expect( next.nodes ).toBe( EMPTY.nodes );
	} );

	test( 'secure sets the level', () => {
		const next = draftReducer( EMPTY, { type: 'secure', level: 2 } );

		expect( next.secureLevel ).toBe( 2 );
	} );

	test( 'the edge and node-config verbs route to their draftGraph function', () => {
		// connect_node / disconnect_node / set_arguments / cmd / remove_include
		// — every remaining branch, so the routing table has no dark corners.
		const seeded = addNode( EMPTY, {
			shellName: 'Tee',
			name: 'router-tee',
			x: 0,
			y: 0,
		} );
		const id = seeded.nodes[ 0 ].id;

		expect(
			draftReducer( seeded, {
				type: 'set_arguments',
				id,
				ctorArgs: [ 'a', 'b' ],
			} )
		).toEqual( updateNodeArgs( seeded, id, [ 'a', 'b' ] ) );

		expect(
			draftReducer( seeded, {
				type: 'cmd',
				id,
				verbInvocations: [ { verb: 'void_warranty' } ],
			} )
		).toEqual(
			updateNodeVerbs( seeded, id, [ { verb: 'void_warranty' } ] )
		);

		const withInclude = draftReducer( EMPTY, {
			type: 'include',
			name: 'topic-probe',
		} );
		expect(
			draftReducer( withInclude, {
				type: 'remove_include',
				name: 'topic-probe',
			} )
		).toEqual( removeInclude( withInclude, 'topic-probe' ) );

		const two = addNode( seeded, {
			shellName: 'Tee',
			name: 'sink-tee',
			x: 1,
			y: 1,
		} );
		const [ a, b ] = two.nodes.map( ( n ) => n.id );
		expect(
			draftReducer( two, { type: 'connect_node', from: a, to: b } )
		).toEqual( connectDraftEdge( two, a, b, [] ) );

		const linked = connectDraftEdge( two, a, b, [] );
		expect(
			draftReducer( linked, { type: 'disconnect_node', from: a, to: b } )
		).toEqual( removeEdge( linked, a, b ) );
	} );

	test( 'revertIncludes drops what is not last-good, via remove_include', () => {
		// The expand-error backstop. Reverting is a sequence of the verb that
		// owns includes, not a wholesale rewrite of the field it owns.
		const seeded = [ 'topic-probe', 'job-intake', 'wombat-probe' ].reduce(
			( g, name ) => draftReducer( g, { type: 'include', name } ),
			EMPTY
		);

		const reverted = revertIncludes( seeded, {
			'topic-probe': {},
			'job-intake': {},
		} );

		expect( reverted.includes ).toEqual( [ 'topic-probe', 'job-intake' ] );
	} );

	test( 'revertIncludes never ADDS an include the draft dropped', () => {
		// The wholesale rewrite it replaces would resurrect one, because the
		// last-good tree lags a removal until the next successful expand.
		const seeded = draftReducer( EMPTY, {
			type: 'include',
			name: 'topic-probe',
		} );

		const reverted = revertIncludes( seeded, {
			'topic-probe': {},
			'job-intake': {},
		} );

		expect( reverted.includes ).toEqual( [ 'topic-probe' ] );
	} );

	test( 'revertIncludes with nothing stale returns the same object', () => {
		const seeded = draftReducer( EMPTY, {
			type: 'include',
			name: 'topic-probe',
		} );

		expect( revertIncludes( seeded, { 'topic-probe': {} } ) ).toBe(
			seeded
		);
	} );

	test( 'an unknown action returns the same object, not a copy', () => {
		// Identity, so a stray dispatch cannot trigger a re-render.
		const state = addNode( EMPTY, {
			shellName: 'Tee',
			name: 'untouched',
			x: 0,
			y: 0,
		} );

		expect( draftReducer( state, { type: 'no_such_verb' } ) ).toBe( state );
	} );
} );
