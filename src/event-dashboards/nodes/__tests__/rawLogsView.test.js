import { VALUE, TYPE, TM_STRUCT, newMessage } from '../../../runtime/message';
import { Core } from '../../../runtime/core';
import { createRawLogsView } from '../rawLogsView';

// setName registers in the per-process Core registry; clear it between tests
// so re-creating the same-named node doesn't collide (matches node.test.js).
beforeEach( () => Core.reset() );

// A row message from rawlogs/transform: TM_STRUCT carrying { p, line }.
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

test( 'appends rows newest-first and caps the buffer', () => {
	const v = createRawLogsView( 'rawlogs/view' );
	v.fill( rowMsg( 'line 0' ) );
	v.fill( rowMsg( 'line 1' ) );
	v.fill( rowMsg( 'line 2' ) );
	const { lines } = v.setStateCache.view;
	expect( lines[ 0 ].content ).toBe( 'line 2' ); // newest first (unshift)
	expect( lines ).toHaveLength( 3 );
} );

test( 'pause stops appends; the model reflects paused', () => {
	const v = createRawLogsView( 'rawlogs/view' );
	v.fill( controlMsg( { action: 'pause', paused: true } ) );
	v.fill( rowMsg( 'ignored' ) );
	expect( v.setStateCache.view.lines ).toHaveLength( 0 );
	expect( v.setStateCache.view.paused ).toBe( true );
} );

test( 'select sets the log and clears the buffer', () => {
	const v = createRawLogsView( 'rawlogs/view' );
	v.fill( rowMsg( 'old' ) );
	v.fill( controlMsg( { action: 'select', log: 'errors' } ) );
	expect( v.setStateCache.view.lines ).toHaveLength( 0 );
	expect( v.setStateCache.view.selected ).toBe( 'errors' );
} );

test( 'logs action populates availableLogs and defaults the selection', () => {
	const v = createRawLogsView( 'rawlogs/view' );
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
	const v = createRawLogsView( 'rawlogs/view' );
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
	const v = createRawLogsView( 'rawlogs/view' );
	v.fill( controlMsg( { action: 'pause', paused: true } ) );
	v.fill( rowMsg( 'dropped' ) );
	v.fill( controlMsg( { action: 'pause', paused: false } ) );
	v.fill( rowMsg( 'kept' ) );
	expect( v.setStateCache.view.paused ).toBe( false );
	expect( v.setStateCache.view.lines ).toHaveLength( 1 );
	expect( v.setStateCache.view.lines[ 0 ].content ).toBe( 'kept' );
} );

test( 'rows carry the partition and an even/odd flag keyed off the counter', () => {
	const v = createRawLogsView( 'rawlogs/view' );
	v.fill( rowMsg( 'first', 2 ) ); // counter 1 → odd
	v.fill( rowMsg( 'second', 3 ) ); // counter 2 → even
	const { lines } = v.setStateCache.view;
	expect( lines[ 0 ] ).toMatchObject( {
		partition: 3,
		content: 'second',
		isEven: true,
	} );
	expect( lines[ 1 ] ).toMatchObject( {
		partition: 2,
		content: 'first',
		isEven: false,
	} );
} );

test( 'publishes a numeric lps in the view model', () => {
	const v = createRawLogsView( 'rawlogs/view' );
	v.fill( rowMsg( 'a row' ) );
	expect( typeof v.setStateCache.view.lps ).toBe( 'number' );
} );

test( 'select clears the lps back to zero', () => {
	const v = createRawLogsView( 'rawlogs/view' );
	for ( let i = 0; i < 50; i++ ) {
		v.fill( rowMsg( `row ${ i }` ) );
	}
	v.fill( controlMsg( { action: 'select', log: 'errors' } ) );
	expect( v.setStateCache.view.lps ).toBe( 0 );
} );

test( 'names the node', () => {
	const v = createRawLogsView( 'rawlogs/view' );
	expect( v.name ).toBe( 'rawlogs/view' );
} );
