/**
 * DraftContext — the draft document's React seam. `useDraftDispatch` is the one
 * door every document mutation goes through; `DraftProvider` carries the
 * document to consumers so they stop taking it as pass-through props.
 *
 * The provider deliberately does NOT own the state. TopologyConsole still holds
 * it, because loading a topology replaces the whole document and that is not a
 * verb. Ownership moves in Stage 2, when a `Draft_Node` takes it.
 */

import { renderHook, act } from '@testing-library/react';
import { DraftProvider, useDraft, useDraftDispatch } from '../DraftContext';
import { addNode } from '../utils/draftGraph';

const EMPTY = { nodes: [], edges: [], frontmatter: {} };

describe( 'useDraftDispatch', () => {
	it( 'applies the reducer to the graph the setter hands it', () => {
		let graph = addNode( EMPTY, {
			shellName: 'Tee',
			name: 'before-dispatch',
			x: 0,
			y: 0,
		} );
		const setDraft = ( updater ) => {
			graph = updater( graph );
		};

		const { result } = renderHook( () => useDraftDispatch( setDraft ) );
		act( () => {
			result.current( {
				type: 'move_node',
				id: 'before-dispatch',
				newName: 'after-dispatch',
			} );
		} );

		expect( graph.nodes[ 0 ].name ).toBe( 'after-dispatch' );
	} );

	it( 'keeps one identity across renders so consumers do not churn', () => {
		const setDraft = () => {};
		const { result, rerender } = renderHook( () =>
			useDraftDispatch( setDraft )
		);
		const first = result.current;
		rerender();

		expect( result.current ).toBe( first );
	} );
} );

describe( 'useDraft', () => {
	it( 'carries the draft and dispatch to a consumer', () => {
		const draft = { ...EMPTY, secureLevel: 3 };
		const dispatch = () => {};
		const wrapper = ( { children } ) => (
			<DraftProvider draft={ draft } dispatch={ dispatch }>
				{ children }
			</DraftProvider>
		);

		const { result } = renderHook( () => useDraft(), { wrapper } );

		expect( result.current.draft ).toBe( draft );
		expect( result.current.dispatch ).toBe( dispatch );
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
