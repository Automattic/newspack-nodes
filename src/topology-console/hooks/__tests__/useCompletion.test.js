import { renderHook } from '@testing-library/react';
import { useCompletion } from '../useCompletion';
import { tabulateCandidates } from '../../../runtime/completion-node';
import {
	TYPE,
	FROM,
	TO,
	KEY,
	VALUE,
	LOCAL,
	TM_COMMAND,
} from '../../../runtime/message';
import names from '../../../runtime/reserved-node-names.json';

const render = ( opts ) => {
	const fill = jest.fn();
	const append = jest.fn();
	const { result } = renderHook( () =>
		useCompletion( { fill, append, ...opts } )
	);
	return { result, fill, append };
};

describe( 'useCompletion', () => {
	it( 'requestCompletion on the first token fills a `help` command at cwd', () => {
		const { result, fill } = render( { cwd: '_http/w.p0' } );
		result.current.requestCompletion( 'foo' );
		expect( fill ).toHaveBeenCalledTimes( 1 );
		const m = fill.mock.calls[ 0 ][ 0 ];
		expect( m[ TYPE ] ).toBe( TM_COMMAND );
		expect( m[ FROM ] ).toBe( names.COMPLETION );
		expect( m[ TO ] ).toBe( '_http/w.p0' );
		expect( m[ KEY ] ).toBe( 'completion' );
		expect( m[ VALUE ] ).toMatchObject( { name: 'help', arguments: [] } );
		expect( m[ LOCAL ] ).toBe( true );
	} );

	it( 'requestCompletion on a later token fills an `ls` command', () => {
		const { result, fill } = render( { cwd: '' } );
		result.current.requestCompletion( 'foo ' );
		const m = fill.mock.calls[ 0 ][ 0 ];
		expect( m[ VALUE ] ).toMatchObject( { name: 'ls', arguments: [] } );
	} );

	it( 'no-ops when skip() returns true', () => {
		const { result, fill } = render( {
			cwd: 'w.p0',
			skip: () => true,
		} );
		result.current.requestCompletion( 'foo' );
		expect( fill ).not.toHaveBeenCalled();
	} );

	it( 'fills when skip() returns false', () => {
		const { result, fill } = render( {
			cwd: 'w.p0',
			skip: () => false,
		} );
		result.current.requestCompletion( 'foo' );
		expect( fill ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'defaults skip to never-skip when omitted', () => {
		const { result, fill } = render( { cwd: 'w.p0' } );
		result.current.requestCompletion( 'foo' );
		expect( fill ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'handleShowCandidates appends a tabulated recv line', () => {
		const { result, append } = render( { cwd: '' } );
		result.current.handleShowCandidates( [ 'a', 'b' ] );
		expect( append ).toHaveBeenCalledWith( {
			kind: 'recv',
			text: tabulateCandidates( [ 'a', 'b' ] ),
		} );
	} );
} );
