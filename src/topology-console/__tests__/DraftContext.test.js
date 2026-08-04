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

		// A draft `firehose` must never be the running one.
		expect(
			result.current.interpreter.childRegistry.node( 'meerkat' )
		).not.toBeNull();
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

		expect( result.current.interpreter ).toBe( draft.interpreter );
		expect( result.current.run ).toBe( draft.run );
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
