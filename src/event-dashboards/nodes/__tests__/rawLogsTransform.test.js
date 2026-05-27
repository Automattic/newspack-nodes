import {
	KEY,
	TO,
	VALUE,
	TYPE,
	TM_BYTESTREAM,
	TM_STRUCT,
	newMessage,
} from '../../../runtime/message';
import { Core } from '../../../runtime/core';
import { createRawLogsTransform } from '../rawLogsTransform';

// setName registers in the per-process Core registry; clear it between tests
// so re-creating the same-named node doesn't collide (matches node.test.js).
beforeEach( () => Core.reset() );

// Capture sink: a minimal node whose fill() records every message it receives.
function capture() {
	const got = [];
	return { node: { fill: ( m ) => got.push( m ) }, got };
}

// A transform wired the exospine way: sink = the CI capture, target = the view.
function transformWithCapture() {
	const sink = capture();
	const t = createRawLogsTransform( 'rawlogs:transform' );
	t.sink = sink.node;
	t.target = 'rawlogs:view';
	return { t, got: sink.got };
}

test( 'emits one row message for a log envelope, stamped TO the view', () => {
	const { t, got } = transformWithCapture();
	const env = newMessage();
	env[ TYPE ] = TM_BYTESTREAM;
	env[ KEY ] = 'p0';
	env[ VALUE ] = 'something happened';
	t.fill( env );
	expect( got ).toHaveLength( 1 );
	expect( got[ 0 ][ VALUE ] ).toMatchObject( { line: expect.any( String ) } );
	expect( got[ 0 ][ TO ] ).toBe( 'rawlogs:view' );
} );

test( 'emitted row message is TM_STRUCT carrying { p, line }', () => {
	const { t, got } = transformWithCapture();
	const env = newMessage();
	env[ TYPE ] = TM_BYTESTREAM;
	env[ KEY ] = 'p0';
	env[ VALUE ] = 'hello world';
	t.fill( env );
	expect( got[ 0 ][ TYPE ] ).toBe( TM_STRUCT );
	expect( got[ 0 ][ VALUE ] ).toMatchObject( {
		p: expect.any( Number ),
		line: 'p0: hello world',
	} );
} );

test( 'drops the connected sentinel', () => {
	const { t, got } = transformWithCapture();
	const env = newMessage();
	env[ KEY ] = 'connected';
	t.fill( env );
	expect( got ).toHaveLength( 0 );
} );

test( 'drops a malformed envelope whose transform returns null', () => {
	const { t, got } = transformWithCapture();
	const env = newMessage();
	env[ KEY ] = 'p0';
	env[ VALUE ] = ''; // empty VALUE → transformLogLine returns null.
	t.fill( env );
	expect( got ).toHaveLength( 0 );
} );

test( 'names the node', () => {
	const t = createRawLogsTransform( 'rawlogs:transform' );
	expect( t.name ).toBe( 'rawlogs:transform' );
} );
