import { DmesgNode, countLevels } from '../dmesg-node';
import { Core } from '../core';
import { newMessage, TYPE, VALUE, TM_COMMAND, TM_RESPONSE } from '../message';

beforeEach( () => Core.reset() );

describe( 'countLevels', () => {
	it( 'classifies dmesg lines (WARNING wins over ERROR), ignoring blanks', () => {
		const text = [
			'2026-01-01 12:00:00 ERROR: boom',
			'2026-01-01 12:00:01 WARNING: careful',
			'2026-01-01 12:00:02 WARNING: ERROR: warning wins',
			'2026-01-01 12:00:03 plain debug line',
			'',
			'   ',
		].join( '\n' );
		expect( countLevels( text ) ).toEqual( {
			errors: 1,
			warnings: 2,
			debug: 1,
		} );
	} );

	it( 'is zero-safe for empty / missing input', () => {
		expect( countLevels( '' ) ).toEqual( {
			errors: 0,
			warnings: 0,
			debug: 0,
		} );
		expect( countLevels( undefined ).errors ).toBe( 0 );
	} );
} );

describe( 'DmesgNode', () => {
	it( 'publishes {errors,warnings,debug} from a dmesg reply payload', () => {
		const node = new DmesgNode();
		node.name = '_dmesg';
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
		m[ VALUE ] = { payload: 'ERROR: a\nWARNING: b\ndebug c' };
		node.fill( m );
		expect( node.setStateCache.dmesg ).toEqual( {
			errors: 1,
			warnings: 1,
			debug: 1,
		} );
	} );

	it( 'fire() emits a dmesg poll command to its target', () => {
		const node = new DmesgNode();
		node.name = '_dmesg';
		node.target = '_cwd';
		const sent = [];
		node.sink = { fill: ( msg ) => sent.push( msg ) };
		node.fire();
		expect( sent ).toHaveLength( 1 );
		expect( sent[ 0 ][ VALUE ] ).toEqual( {
			name: 'dmesg',
			arguments: '',
		} );
	} );
} );
