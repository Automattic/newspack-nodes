import {
	TYPE,
	TIMESTAMP,
	FROM,
	TO,
	ID,
	KEY,
	VALUE,
	LAST_VALUE_INDEX,
	LOCAL,
	TM_BYTESTREAM,
	TM_EOF,
	TM_PING,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	TM_INFO,
	TM_STRUCT,
	TM_REQUEST,
	newMessage,
	pack,
	unpack,
	valueSize,
} from '../message';

test( 'field index constants match PHP layout', () => {
	expect( TYPE ).toBe( 0 );
	expect( TIMESTAMP ).toBe( 1 );
	expect( FROM ).toBe( 2 );
	expect( TO ).toBe( 3 );
	expect( ID ).toBe( 4 );
	expect( KEY ).toBe( 5 );
	expect( VALUE ).toBe( 6 );
	expect( LAST_VALUE_INDEX ).toBe( 6 );
} );

test( 'TM_* flags are single-bit', () => {
	expect( TM_BYTESTREAM ).toBe( 1 );
	expect( TM_EOF ).toBe( 2 );
	expect( TM_PING ).toBe( 4 );
	expect( TM_COMMAND ).toBe( 8 );
	expect( TM_STRUCT ).toBe( 16 );
	expect( TM_ERROR ).toBe( 32 );
	expect( TM_INFO ).toBe( 64 );
	expect( TM_REQUEST ).toBe( 128 );
	expect( TM_RESPONSE ).toBe( 256 );
} );

test( 'newMessage returns a 7-slot array with TYPE=0, blank string slots', () => {
	const m = newMessage();
	expect( m ).toHaveLength( 7 );
	expect( m[ TYPE ] ).toBe( 0 );
	expect( typeof m[ TIMESTAMP ] ).toBe( 'number' );
	expect( m[ FROM ] ).toBe( '' );
	expect( m[ TO ] ).toBe( '' );
	expect( m[ ID ] ).toBe( '' );
	expect( m[ KEY ] ).toBe( '' );
	expect( m[ VALUE ] ).toBe( '' );
} );

test( 'pack/unpack roundtrips', () => {
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ FROM ] = 'producer';
	m[ VALUE ] = 'hello\nworld';
	const round = unpack( pack( m ) );
	expect( round[ TYPE ] ).toBe( TM_BYTESTREAM );
	expect( round[ FROM ] ).toBe( 'producer' );
	expect( round[ VALUE ] ).toBe( 'hello\nworld' );
} );

test( 'unpack with non-array JSON returns a fresh new message', () => {
	const m = unpack( '"not an array"' );
	expect( m ).toHaveLength( 7 );
	expect( m[ TYPE ] ).toBe( 0 );
} );

test( 'unpack with truncated array returns a fresh new message', () => {
	const m = unpack( '[1,2,3]' );
	expect( m ).toHaveLength( 7 );
	expect( m[ TYPE ] ).toBe( 0 );
} );

test( 'LOCAL is index 7, after the canonical fields', () => {
	expect( LOCAL ).toBe( 7 );
	expect( LOCAL ).toBe( LAST_VALUE_INDEX + 1 );
} );

test( 'pack strips the LOCAL provenance field', () => {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ LOCAL ] = true;
	const decoded = JSON.parse( pack( m ) );
	expect( decoded ).toHaveLength( 7 );
	expect( decoded[ LOCAL ] ).toBeUndefined();
} );

test( 'unpack drops any trailing LOCAL field on the wire', () => {
	const m = unpack( '[0,0,"","","","","",true]' );
	expect( m ).toHaveLength( 7 );
	expect( m[ LOCAL ] ).toBeUndefined();
} );

test( 'valueSize on string VALUE returns byte length', () => {
	const m = newMessage();
	m[ VALUE ] = 'abcd';
	expect( valueSize( m ) ).toBe( 4 );
} );

test( 'valueSize on object VALUE returns JSON-encoded byte length', () => {
	const m = newMessage();
	m[ VALUE ] = { k: 'v' };
	expect( valueSize( m ) ).toBe( JSON.stringify( { k: 'v' } ).length );
} );

test( 'unpack returns a fresh new message on invalid JSON', () => {
	const m = unpack( 'not json' );
	expect( m ).toHaveLength( 7 );
	expect( m[ TYPE ] ).toBe( 0 );
} );

test( 'valueSize returns 0 when VALUE is null or undefined', () => {
	const m = newMessage();
	m[ VALUE ] = null;
	expect( valueSize( m ) ).toBe( 0 );
	m[ VALUE ] = undefined;
	expect( valueSize( m ) ).toBe( 0 );
} );

test( 'valueSize on multibyte string returns UTF-8 byte count, not char count', () => {
	const m = newMessage();
	m[ VALUE ] = 'é'; // 1 JS char, 2 UTF-8 bytes — matches PHP strlen()
	expect( valueSize( m ) ).toBe( 2 );
	m[ VALUE ] = '日本'; // 2 JS chars, 6 UTF-8 bytes (3 each)
	expect( valueSize( m ) ).toBe( 6 );
} );
