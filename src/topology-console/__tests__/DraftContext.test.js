/**
 * DraftContext — the draft document's React seam.
 *
 * The claim under test is Stage 2's: edit mode sends the SAME commands live
 * mode does, to a different interpreter. So the mutation door takes a TSL
 * LINE, and what comes back is a read of a real node graph — not a reducer's
 * opinion of one. The provider carries the document now, because the
 * interpreter owns it.
 */

import { renderHook, act } from '@testing-library/react';
import { Core } from '../../runtime/core';
import { DraftProvider, useDraft, useDraftInterpreter } from '../DraftContext';

describe( 'useDraftInterpreter', () => {
	it( 'runs a TSL line and re-reads the graph', () => {
		const { result } = renderHook( () => useDraftInterpreter() );
		expect( result.current.graph.nodes ).toEqual( [] );

		act( () => {
			result.current.run( 'make_node Grep aardvark ^wombat' );
		} );

		const node = result.current.graph.nodes.find(
			( n ) => n.id === 'aardvark'
		);
		expect( node.class ).toBe( 'Grep' );
		expect( node.ctorArgs ).toEqual( [ '^wombat' ] );
	} );

	it( 'applies move_node, references and all', () => {
		const { result } = renderHook( () => useDraftInterpreter() );
		act( () => {
			result.current.run( 'make_node Tee before-dispatch' );
			result.current.run( 'make_node Echo pangolin' );
			result.current.run( 'connect_node before-dispatch pangolin' );
		} );

		act( () => {
			result.current.run( 'move_node before-dispatch after-dispatch' );
		} );

		expect( result.current.graph.nodes.map( ( n ) => n.id ) ).toEqual( [
			'after-dispatch',
			'pangolin',
		] );
		expect( result.current.graph.edges ).toEqual( [
			{ from: 'after-dispatch', to: 'pangolin', roles: [ 'connect' ] },
		] );
	} );

	it( 'replaces the whole document on load, and returns the new graph', () => {
		const { result } = renderHook( () => useDraftInterpreter() );
		act( () => {
			result.current.run( 'make_node Grep quokka ^x' );
		} );

		let returned;
		act( () => {
			returned = result.current.load( 'make_node Echo armadillo' );
		} );

		expect( returned.nodes.map( ( n ) => n.id ) ).toEqual( [
			'armadillo',
		] );
		expect( result.current.graph.nodes.map( ( n ) => n.id ) ).toEqual( [
			'armadillo',
		] );
	} );

	/**
	 * The editor guard used to scan only the DOCUMENT's own verbs, while the
	 * live seed's `withResolvedConfigEdges` scans the composed graph — so an
	 * include seeding `set_stats_target <config:…>` was refused live and
	 * accepted in the editor, and a save wrote routing never shown.
	 */
	it( 'refuses an unresolved token target seeded by an include', () => {
		const { result } = renderHook( () => useDraftInterpreter() );
		act( () => {
			result.current.load( 'include shared-stats', {
				nodes: [
					{
						name: 'meerkat',
						class: 'Job_Worker',
						origin: [ 'shared-stats' ],
						verbs: [
							{
								verb: 'set_stats_target',
								args: [ '<wombat:sink>' ],
							},
						],
					},
				],
				edges: [],
			} );
		} );

		expect( () => result.current.assertResolved( undefined ) ).toThrow(
			/Missing resolved_config_edges/
		);
	} );

	it( 'keeps one door identity across renders so consumers do not churn', () => {
		const { result, rerender } = renderHook( () => useDraftInterpreter() );
		const first = result.current.run;
		rerender();

		expect( result.current.run ).toBe( first );
	} );

	it( 'keeps its nodes in its own registry, not the live table', () => {
		const { result } = renderHook( () => useDraftInterpreter() );
		act( () => {
			result.current.run( 'make_node Grep meerkat ^y' );
		} );

		// A draft `firehose` must never be the running one: the node is in
		// the document, and nowhere in the live table.
		expect( result.current.graph.nodes.map( ( n ) => n.id ) ).toContain(
			'meerkat'
		);
		expect( Core.node( 'meerkat' ) ).toBeNull();
	} );
} );

describe( 'useDraft', () => {
	it( 'carries the document to a consumer', () => {
		const owner = renderHook( () => useDraftInterpreter() );
		const draft = owner.result.current;
		const wrapper = ( { children } ) => (
			<DraftProvider draft={ draft }>{ children }</DraftProvider>
		);

		const { result } = renderHook( () => useDraft(), { wrapper } );

		expect( result.current.run ).toBe( draft.run );
		expect( result.current.graph ).toBe( draft.graph );
		// The interpreter itself is NOT on the surface — reaching past these
		// operations is how the last design drifted.
		expect( result.current.interpreter ).toBeUndefined();
	} );

	it( 'throws outside a provider rather than serving an empty document', () => {
		// React logs the deliberately-failing render; the suite's console gate
		// would read that as a violation, so swallow it for this test alone.
		const quiet = jest
			.spyOn( console, 'error' )
			.mockImplementation( () => {} );
		try {
			// Fail loud: a default here reads as "the topology is empty".
			expect( () => renderHook( () => useDraft() ) ).toThrow(
				/DraftProvider/
			);
		} finally {
			quiet.mockRestore();
		}
	} );
} );

describe( 'revertIncludes', () => {
	it( 'returns null when nothing was stale, so a caller cannot spin', () => {
		// It used to commit regardless, minting a new graph every call. An
		// effect keyed on graph identity then re-ran forever — which is what
		// a persistent expand error does.
		const { result } = renderHook( () => useDraftInterpreter() );
		act( () => {
			result.current.run( 'include shared' );
		} );

		let out;
		act( () => {
			out = result.current.revertIncludes( { shared: {} } );
		} );

		expect( out ).toBeNull();
		expect( result.current.graph.includes ).toEqual( [ 'shared' ] );
	} );

	it( 'drops an include the last good tree lacks, and commits that', () => {
		const { result } = renderHook( () => useDraftInterpreter() );
		act( () => {
			result.current.run( 'include shared' );
			result.current.run( 'include gone' );
		} );

		act( () => {
			result.current.revertIncludes( { shared: {} } );
		} );

		expect( result.current.graph.includes ).toEqual( [ 'shared' ] );
	} );
} );
