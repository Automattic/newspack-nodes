import {
	payloadOf,
	typeLabels,
	TYPE,
	TIMESTAMP,
	FROM,
	TO,
	ID,
	KEY,
	VALUE,
	LAST_VALUE_INDEX,
	LOCAL,
	TM_UNTYPED,
	TM_BYTESTREAM,
	TM_EOF,
	TM_PING,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	TM_INFO,
	TM_STRUCT,
	TM_REQUEST,
	TM_NOREPLY,
	newMessage,
	pack,
	unpack,
	valueSize,
	byteLength,
	applyComposeFields,
} from '../message';

test( 'byteLength counts UTF-8 bytes and treats nullish as zero', () => {
	expect( byteLength( 'abc' ) ).toBe( 3 );
	expect( byteLength( '€' ) ).toBe( 3 );
	expect( byteLength( '' ) ).toBe( 0 );
	expect( byteLength( null ) ).toBe( 0 );
	expect( byteLength( undefined ) ).toBe( 0 );
} );

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
	expect( TM_NOREPLY ).toBe( 512 );
} );

test( 'newMessage returns a 7-slot array with TYPE=TM_UNTYPED, blank string slots', () => {
	const m = newMessage();
	expect( m ).toHaveLength( 7 );
	expect( m[ TYPE ] ).toBe( TM_UNTYPED );
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
	expect( m[ TYPE ] ).toBe( TM_UNTYPED );
} );

test( 'unpack with truncated array returns a fresh new message', () => {
	const m = unpack( '[1,2,3]' );
	expect( m ).toHaveLength( 7 );
	expect( m[ TYPE ] ).toBe( TM_UNTYPED );
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
	expect( m[ TYPE ] ).toBe( TM_UNTYPED );
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

test( 'applyComposeFields stamps FROM / ID / KEY / TIMESTAMP from the composer fields', () => {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = '_output/9';
	applyComposeFields( m, {
		from: 'elsewhere/sink',
		id: '4242',
		key: 'trace-77',
		timestamp: '1700000000',
	} );
	expect( m[ FROM ] ).toBe( 'elsewhere/sink' );
	expect( m[ ID ] ).toBe( '4242' );
	expect( m[ KEY ] ).toBe( 'trace-77' );
	expect( m[ TIMESTAMP ] ).toBe( '1700000000' );
} );

test( 'applyComposeFields leaves a field alone when its composer input is blank', () => {
	const m = newMessage();
	m[ FROM ] = '_output/9';
	m[ KEY ] = 'preset';
	const clock = m[ TIMESTAMP ];
	applyComposeFields( m, { from: '', id: '', key: '', timestamp: '' } );
	expect( m[ FROM ] ).toBe( '_output/9' );
	expect( m[ ID ] ).toBe( '' );
	expect( m[ KEY ] ).toBe( 'preset' );
	expect( m[ TIMESTAMP ] ).toBe( clock );
} );

test( 'applyComposeFields ORs TM_RESPONSE / TM_ERROR onto TYPE per the flags object', () => {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	applyComposeFields( m, { response: true, error: false } );
	expect( m[ TYPE ] ).toBe( TM_COMMAND | TM_RESPONSE );

	const m2 = newMessage();
	m2[ TYPE ] = TM_COMMAND;
	applyComposeFields( m2, { response: false, error: true } );
	expect( m2[ TYPE ] ).toBe( TM_COMMAND | TM_ERROR );

	const m3 = newMessage();
	m3[ TYPE ] = TM_COMMAND;
	applyComposeFields( m3, { response: true, error: true } );
	expect( m3[ TYPE ] ).toBe( TM_COMMAND | TM_RESPONSE | TM_ERROR );
} );

test( 'applyComposeFields is a no-op when flags is null/undefined or both false', () => {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	applyComposeFields( m, null );
	expect( m[ TYPE ] ).toBe( TM_COMMAND );
	applyComposeFields( m, undefined );
	expect( m[ TYPE ] ).toBe( TM_COMMAND );
	applyComposeFields( m, { response: false, error: false } );
	expect( m[ TYPE ] ).toBe( TM_COMMAND );
} );

test( 'applyComposeFields returns the same message it mutated', () => {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	expect( applyComposeFields( m, { response: true } ) ).toBe( m );
} );

// The ONE flags-to-names map lives beside the constants it names, as in PHP
// Message::type_labels(). Two renderers (the drop audit, the Dumper header)
// each filtered a private copy — which is how one ends up omitting a flag.
describe( 'typeLabels', () => {
	it( 'names every set flag of a composite type, in table order', () => {
		expect( typeLabels( TM_COMMAND | TM_ERROR ) ).toEqual( [
			'TM_COMMAND',
			'TM_ERROR',
		] );
	} );

	it( 'returns nothing when no known flag matches, so callers name that case', () => {
		expect( typeLabels( 0 ) ).toEqual( [] );
	} );
} );

// Eight files each spelled this ternary out by hand, and two of them wrote it
// the wrong way round. It is the envelope's own accessor, so it lives beside
// the envelope: a command reply wraps its result in `{ name, arguments,
// payload }`, and everything else IS the value.
describe( 'payloadOf', () => {
	it( 'unwraps a command reply to its payload', () => {
		expect(
			payloadOf( {
				name: 'save',
				arguments: [ 'wombat-4471' ],
				payload: { restarted: 3 },
			} )
		).toEqual( { restarted: 3 } );
	} );

	it( 'passes a bare value through untouched', () => {
		expect( payloadOf( 'no such topology' ) ).toBe( 'no such topology' );
		expect( payloadOf( 4471 ) ).toBe( 4471 );
	} );

	it( 'passes an array through — a list reply IS the value', () => {
		expect( payloadOf( [ 'a', 'b' ] ) ).toEqual( [ 'a', 'b' ] );
	} );

	it( 'reads an envelope whose payload is absent as null, not undefined', () => {
		expect( payloadOf( { name: 'activate' } ) ).toBeNull();
	} );

	it( 'reads null and undefined as null', () => {
		expect( payloadOf( null ) ).toBeNull();
		expect( payloadOf( undefined ) ).toBeNull();
	} );
} );
