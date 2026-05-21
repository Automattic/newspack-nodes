/**
 * transformLogLine tests — Message envelope → `{ p, line }` row shape.
 */

import transformLogLine from '../transformLogLine';

const TYPE = 0;
const TIMESTAMP = 1;
const FROM = 2;
const TO = 3;
const ID = 4;
const KEY = 5;
const VALUE = 6;

function envelope( { from = 'firehose.p0', key = '', value = '' } = {} ) {
	const m = [ 0, 0, '', '', '', '', '' ];
	m[ TYPE ] = 256; // TM_STRUCT
	m[ TIMESTAMP ] = 1.0;
	m[ FROM ] = from;
	m[ TO ] = '';
	m[ ID ] = '0:0';
	m[ KEY ] = key;
	m[ VALUE ] = value;
	return m;
}

describe( 'transformLogLine', () => {
	it( 'extracts partition from FROM stamp `{sub}.pN`', () => {
		const m = envelope( { from: 'firehose.p3', value: 'some line' } );
		const out = transformLogLine( m );
		expect( out.p ).toBe( 3 );
	} );

	it( 'renders object VALUE as JSON', () => {
		const m = envelope( { value: { rid: 'abc', dur: 12.3 } } );
		const out = transformLogLine( m );
		expect( out.line ).toBe( '{"rid":"abc","dur":12.3}' );
	} );

	it( 'prefixes line with `KEY: ` when KEY is non-empty', () => {
		const m = envelope( { key: 'abc-rid', value: { dur: 1 } } );
		const out = transformLogLine( m );
		expect( out.line ).toBe( 'abc-rid: {"dur":1}' );
	} );

	it( 'omits prefix when KEY is empty', () => {
		const m = envelope( { key: '', value: { dur: 1 } } );
		const out = transformLogLine( m );
		expect( out.line ).toBe( '{"dur":1}' );
	} );

	it( 'uses string VALUE verbatim (no extra JSON-wrap)', () => {
		const m = envelope( { value: 'plain text' } );
		const out = transformLogLine( m );
		expect( out.line ).toBe( 'plain text' );
	} );

	it( 'truncates to 1000 chars + ellipsis', () => {
		const m = envelope( { value: 'x'.repeat( 2000 ) } );
		const out = transformLogLine( m );
		expect( out.line.length ).toBe( 1003 );
		expect( out.line.endsWith( '...' ) ).toBe( true );
	} );

	it( 'returns null for empty VALUE', () => {
		const m = envelope( { value: '' } );
		expect( transformLogLine( m ) ).toBeNull();
	} );

	it( 'falls back to partition 0 when FROM does not match {sub}.pN', () => {
		const m = envelope( { from: 'firehose', value: 'x' } );
		const out = transformLogLine( m );
		expect( out.p ).toBe( 0 );
	} );
} );
