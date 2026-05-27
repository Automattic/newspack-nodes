import { Core } from '../../../runtime/core';
import { mountExospine } from '../../../runtime/exospine';
import { dispatchLocal } from '../localCommand';
import { TYPE, TO, VALUE, LOCAL, TM_COMMAND } from '../../../runtime/message';

describe( 'dispatchLocal', () => {
	beforeEach( () => Core.reset() );

	it( 'fills the CI with an empty-TO TM_COMMAND carrying the verb/args/payload', () => {
		const { ci, teardown } = mountExospine();
		const seen = [];
		const orig = ci.fill.bind( ci );
		ci.fill = ( m ) => {
			seen.push( [ ...m ] );
			return orig( m );
		};
		dispatchLocal( ci, 'make_node', 'Tee t1', { foo: 'bar' } );
		// seen[ 0 ] is the dispatched command (later entries are router round-trip echoes, not the helper's concern).
		const m = seen[ 0 ];
		expect( m[ TYPE ] ).toBe( TM_COMMAND );
		expect( m[ TO ] ).toBe( '' );
		expect( m[ LOCAL ] ).toBe( true );
		expect( m[ VALUE ] ).toEqual( {
			name: 'make_node',
			arguments: 'Tee t1',
			payload: { foo: 'bar' },
		} );
		teardown();
	} );

	it( 'actually creates a node when dispatched into a live CI', () => {
		const { ci, teardown } = mountExospine();
		dispatchLocal( ci, 'make_node', 'Tee t1', {} );
		expect( Core.node( 't1' ) ).toBeTruthy();
		teardown();
	} );
} );
