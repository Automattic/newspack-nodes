import { VALUE, TYPE, TM_STRUCT, newMessage } from '../../../runtime/message';
import { Core } from '../../../runtime/core';
import { createRawLogsView } from '../rawLogsView';

// setName registers in the per-process Core registry; clear it between tests
// so re-creating the same-named node doesn't collide (matches node.test.js).
beforeEach( () => Core.reset() );

// A row message from rawlogs:transform: TM_STRUCT carrying { p, line }.
function rowMsg( line, p = 0 ) {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ VALUE ] = { p, line };
	return m;
}

// A control message: TM_STRUCT carrying { action, ... }.
function controlMsg( payload ) {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ VALUE ] = payload;
	return m;
}

// The high-frequency buffer (rows) and LPS now live on the node instance
// directly — _appendRow does NOT publish, so the React view reads node.lines /
// node.lps at frame rate via the rAF, not per-row through setState.
test( 'appends rows newest-first and caps the buffer (node.lines, no publish)', () => {
	const v = createRawLogsView( 'rawlogs:view' );
	v.fill( rowMsg( 'line 0' ) );
	v.fill( rowMsg( 'line 1' ) );
	v.fill( rowMsg( 'line 2' ) );
	expect( v.lines[ 0 ].content ).toBe( 'line 2' ); // newest first (unshift)
	expect( v.lines ).toHaveLength( 3 );
} );

test( 'appending rows does NOT publish setState (no per-row React re-render)', () => {
	const v = createRawLogsView( 'rawlogs:view' );
	const spy = jest.spyOn( v, 'setState' );
	v.fill( rowMsg( 'line 0' ) );
	v.fill( rowMsg( 'line 1' ) );
	expect( spy ).not.toHaveBeenCalled();
} );

test( 'pause stops appends; the model reflects paused', () => {
	const v = createRawLogsView( 'rawlogs:view' );
	v.fill( controlMsg( { action: 'pause', paused: true } ) );
	v.fill( rowMsg( 'ignored' ) );
	expect( v.lines ).toHaveLength( 0 );
	expect( v.setStateCache.view.paused ).toBe( true );
} );

test( 'select sets the log and clears the buffer', () => {
	const v = createRawLogsView( 'rawlogs:view' );
	v.fill( rowMsg( 'old' ) );
	v.fill( controlMsg( { action: 'select', log: 'errors' } ) );
	expect( v.lines ).toHaveLength( 0 );
	expect( v.setStateCache.view.selected ).toBe( 'errors' );
} );

test( 'the published model carries only { connectionError, logs, selected, paused }', () => {
	const v = createRawLogsView( 'rawlogs:view' );
	v.fill(
		controlMsg( {
			action: 'logs',
			logs: [ { key: 'firehose', label: 'firehose.log' } ],
		} )
	);
	expect( Object.keys( v.setStateCache.view ).sort() ).toEqual( [
		'connectionError',
		'logs',
		'paused',
		'selected',
	] );
} );

test( 'logs action populates availableLogs and defaults the selection', () => {
	const v = createRawLogsView( 'rawlogs:view' );
	v.fill(
		controlMsg( {
			action: 'logs',
			logs: [ { key: 'firehose', label: 'firehose.log' } ],
		} )
	);
	expect( v.setStateCache.view.logs ).toHaveLength( 1 );
	expect( v.setStateCache.view.selected ).toBe( 'firehose' );
} );

test( 'logs action does NOT override an already-selected log', () => {
	const v = createRawLogsView( 'rawlogs:view' );
	v.fill( controlMsg( { action: 'select', log: 'errors' } ) );
	v.fill(
		controlMsg( {
			action: 'logs',
			logs: [ { key: 'firehose', label: 'firehose.log' } ],
		} )
	);
	expect( v.setStateCache.view.selected ).toBe( 'errors' );
} );

test( 'resume after pause lets rows through again', () => {
	const v = createRawLogsView( 'rawlogs:view' );
	v.fill( controlMsg( { action: 'pause', paused: true } ) );
	v.fill( rowMsg( 'dropped' ) );
	v.fill( controlMsg( { action: 'pause', paused: false } ) );
	v.fill( rowMsg( 'kept' ) );
	expect( v.setStateCache.view.paused ).toBe( false );
	expect( v.lines ).toHaveLength( 1 );
	expect( v.lines[ 0 ].content ).toBe( 'kept' );
} );

test( 'rows carry the partition and an even/odd flag keyed off the counter', () => {
	const v = createRawLogsView( 'rawlogs:view' );
	v.fill( rowMsg( 'first', 2 ) ); // counter 1 → odd
	v.fill( rowMsg( 'second', 3 ) ); // counter 2 → even
	expect( v.lines[ 0 ] ).toMatchObject( {
		partition: 3,
		content: 'second',
		isEven: true,
	} );
	expect( v.lines[ 1 ] ).toMatchObject( {
		partition: 2,
		content: 'first',
		isEven: false,
	} );
} );

test( 'exposes a numeric lps on the node instance', () => {
	const v = createRawLogsView( 'rawlogs:view' );
	v.fill( rowMsg( 'a row' ) );
	expect( typeof v.lps ).toBe( 'number' );
} );

test( 'select clears node.lps back to zero', () => {
	const v = createRawLogsView( 'rawlogs:view' );
	for ( let i = 0; i < 50; i++ ) {
		v.fill( rowMsg( `row ${ i }` ) );
	}
	v.fill( controlMsg( { action: 'select', log: 'errors' } ) );
	expect( v.lps ).toBe( 0 );
} );

test( 'defaults connectionError to false in the published model', () => {
	const v = createRawLogsView( 'rawlogs:view' );
	// A control publishes the model; connectionError starts false.
	v.fill( controlMsg( { action: 'pause', paused: false } ) );
	expect( v.setStateCache.view.connectionError ).toBe( false );
} );

test( 'a connection control sets connectionError true then false', () => {
	const v = createRawLogsView( 'rawlogs:view' );
	v.fill( controlMsg( { action: 'connection', connectionError: true } ) );
	expect( v.connectionError ).toBe( true );
	expect( v.setStateCache.view.connectionError ).toBe( true );
	v.fill( controlMsg( { action: 'connection', connectionError: false } ) );
	expect( v.connectionError ).toBe( false );
	expect( v.setStateCache.view.connectionError ).toBe( false );
} );

test( 'an unrelated control does not change connectionError', () => {
	const v = createRawLogsView( 'rawlogs:view' );
	v.fill( controlMsg( { action: 'connection', connectionError: true } ) );
	// A pause control + a log row must leave connectionError untouched.
	v.fill( controlMsg( { action: 'pause', paused: true } ) );
	v.fill( rowMsg( 'ignored while paused' ) );
	expect( v.connectionError ).toBe( true );
	expect( v.setStateCache.view.connectionError ).toBe( true );
} );

test( 'names the node', () => {
	const v = createRawLogsView( 'rawlogs:view' );
	expect( v.name ).toBe( 'rawlogs:view' );
} );
