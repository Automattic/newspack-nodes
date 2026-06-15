import {
	FROM,
	KEY,
	VALUE,
	TYPE,
	TM_BYTESTREAM,
	TM_STRUCT,
	newMessage,
} from '../../../runtime/message';
import { Core } from '../../../runtime/core';
import { RawLogsViewNode } from '../rawLogsView';

// setName registers in the per-process Core registry; clear it between tests
// so re-creating the same-named node doesn't collide (matches node.test.js).
beforeEach( () => Core.reset() );

// Construct the node directly (production wires it via interpreter.makeNode;
// bare-newing the class is fine inside a test).
function makeView( name ) {
	const node = new RawLogsViewNode();
	node.name = name;
	return node;
}

// A raw SSE log envelope as it arrives at the view from `_sse` after the
// route+transform chain was collapsed: the view itself shapes
// envelope → `{ p, line }` row inline.
function envelopeMsg( { from = 'firehose.p0', key = '', value = '' } = {} ) {
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ FROM ] = from;
	m[ KEY ] = key;
	m[ VALUE ] = value;
	return m;
}

// A control message: TM_STRUCT carrying { action, ... }. Hook-minted; no
// envelope metadata (no FROM/KEY).
function controlMsg( payload ) {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ VALUE ] = payload;
	return m;
}

// --- Envelope-shaping branches inlined from the deleted rawlogs:transform. ---

test( 'string VALUE passes through verbatim as the line content', () => {
	const v = makeView( 'rawlogs:view' );
	v.fill( envelopeMsg( { value: 'plain text' } ) );
	expect( v.lines ).toHaveLength( 1 );
	expect( v.lines[ 0 ].content ).toBe( 'plain text' );
} );

test( 'object VALUE is JSON-stringified into the line content', () => {
	const v = makeView( 'rawlogs:view' );
	v.fill( envelopeMsg( { value: { rid: 'abc', dur: 12.3 } } ) );
	expect( v.lines[ 0 ].content ).toBe( '{"rid":"abc","dur":12.3}' );
} );

test( 'KEY is prepended to the line when non-empty', () => {
	const v = makeView( 'rawlogs:view' );
	v.fill( envelopeMsg( { key: 'abc-rid', value: { dur: 1 } } ) );
	expect( v.lines[ 0 ].content ).toBe( 'abc-rid: {"dur":1}' );
} );

test( 'KEY prefix is omitted when KEY is empty', () => {
	const v = makeView( 'rawlogs:view' );
	v.fill( envelopeMsg( { key: '', value: { dur: 1 } } ) );
	expect( v.lines[ 0 ].content ).toBe( '{"dur":1}' );
} );

test( 'lines longer than 1000 chars are clipped with a trailing ellipsis', () => {
	const v = makeView( 'rawlogs:view' );
	v.fill( envelopeMsg( { value: 'x'.repeat( 2000 ) } ) );
	expect( v.lines[ 0 ].content.length ).toBe( 1003 );
	expect( v.lines[ 0 ].content.endsWith( '...' ) ).toBe( true );
} );

test( 'partition is extracted from FROM stamp (`{sub}.pN`)', () => {
	const v = makeView( 'rawlogs:view' );
	v.fill( envelopeMsg( { from: 'firehose.p3', value: 'line' } ) );
	expect( v.lines[ 0 ].partition ).toBe( 3 );
} );

test( 'partition defaults to 0 when FROM does not match `{sub}.pN`', () => {
	const v = makeView( 'rawlogs:view' );
	v.fill( envelopeMsg( { from: 'firehose', value: 'line' } ) );
	expect( v.lines[ 0 ].partition ).toBe( 0 );
} );

test( 'an envelope with empty VALUE is dropped (no row appended)', () => {
	const v = makeView( 'rawlogs:view' );
	v.fill( envelopeMsg( { value: '' } ) );
	expect( v.lines ).toHaveLength( 0 );
} );

test( 'an envelope with null VALUE is dropped', () => {
	const v = makeView( 'rawlogs:view' );
	v.fill( envelopeMsg( { value: null } ) );
	expect( v.lines ).toHaveLength( 0 );
} );

// --- Existing buffer / control behavior, fed by raw envelopes now. ---

test( 'appends rows newest-first and caps the buffer (node.lines, no publish)', () => {
	const v = makeView( 'rawlogs:view' );
	v.fill( envelopeMsg( { value: 'line 0' } ) );
	v.fill( envelopeMsg( { value: 'line 1' } ) );
	v.fill( envelopeMsg( { value: 'line 2' } ) );
	expect( v.lines[ 0 ].content ).toBe( 'line 2' );
	expect( v.lines ).toHaveLength( 3 );
} );

test( 'appending rows does NOT publish setState (no per-row React re-render)', () => {
	const v = makeView( 'rawlogs:view' );
	const spy = jest.spyOn( v, 'setState' );
	v.fill( envelopeMsg( { value: 'line 0' } ) );
	v.fill( envelopeMsg( { value: 'line 1' } ) );
	expect( spy ).not.toHaveBeenCalled();
} );

test( 'pause stops appends; the model reflects paused', () => {
	const v = makeView( 'rawlogs:view' );
	v.fill( controlMsg( { action: 'pause', paused: true } ) );
	v.fill( envelopeMsg( { value: 'ignored' } ) );
	expect( v.lines ).toHaveLength( 0 );
	expect( v.setStateCache.view.paused ).toBe( true );
} );

test( 'select sets the log and clears the buffer', () => {
	const v = makeView( 'rawlogs:view' );
	v.fill( envelopeMsg( { value: 'old' } ) );
	v.fill( controlMsg( { action: 'select', log: 'errors.p0' } ) );
	expect( v.lines ).toHaveLength( 0 );
	expect( v.setStateCache.view.selected ).toBe( 'errors.p0' );
} );

test( 'the published model carries only { connectionError, logs, selected, paused }', () => {
	const v = makeView( 'rawlogs:view' );
	v.fill(
		controlMsg( {
			action: 'logs',
			logs: [ { key: 'firehose.p0', label: 'firehose.p0' } ],
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
	const v = makeView( 'rawlogs:view' );
	v.fill(
		controlMsg( {
			action: 'logs',
			logs: [ { key: 'firehose.p0', label: 'firehose.p0' } ],
		} )
	);
	expect( v.setStateCache.view.logs ).toHaveLength( 1 );
	expect( v.setStateCache.view.selected ).toBe( 'firehose.p0' );
} );

test( 'logs action does NOT override an already-selected log', () => {
	const v = makeView( 'rawlogs:view' );
	v.fill( controlMsg( { action: 'select', log: 'errors.p0' } ) );
	v.fill(
		controlMsg( {
			action: 'logs',
			logs: [ { key: 'firehose.p0', label: 'firehose.p0' } ],
		} )
	);
	expect( v.setStateCache.view.selected ).toBe( 'errors.p0' );
} );

test( 'resume after pause lets rows through again', () => {
	const v = makeView( 'rawlogs:view' );
	v.fill( controlMsg( { action: 'pause', paused: true } ) );
	v.fill( envelopeMsg( { value: 'dropped' } ) );
	v.fill( controlMsg( { action: 'pause', paused: false } ) );
	v.fill( envelopeMsg( { value: 'kept' } ) );
	expect( v.setStateCache.view.paused ).toBe( false );
	expect( v.lines ).toHaveLength( 1 );
	expect( v.lines[ 0 ].content ).toBe( 'kept' );
} );

test( 'rows carry the partition (from FROM) and an even/odd flag keyed off the counter', () => {
	const v = makeView( 'rawlogs:view' );
	v.fill( envelopeMsg( { from: 'firehose.p2', value: 'first' } ) );
	v.fill( envelopeMsg( { from: 'firehose.p3', value: 'second' } ) );
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
	const v = makeView( 'rawlogs:view' );
	v.fill( envelopeMsg( { value: 'a row' } ) );
	expect( typeof v.lps ).toBe( 'number' );
} );

test( 'select clears node.lps back to zero', () => {
	const v = makeView( 'rawlogs:view' );
	for ( let i = 0; i < 50; i++ ) {
		v.fill( envelopeMsg( { value: `row ${ i }` } ) );
	}
	v.fill( controlMsg( { action: 'select', log: 'errors.p0' } ) );
	expect( v.lps ).toBe( 0 );
} );

test( 'caps the buffer at maxLines, dropping the oldest and keeping the newest at [0]', () => {
	const v = new RawLogsViewNode( 3 );
	v.name = 'rawlogs:view';
	for ( let i = 0; i < 10; i++ ) {
		v.fill( envelopeMsg( { value: `line ${ i }` } ) );
	}
	expect( v.lines ).toHaveLength( 3 );
	expect( v.lines.map( ( l ) => l.content ) ).toEqual( [
		'line 9',
		'line 8',
		'line 7',
	] );
} );

test( 'exposes O(1) windowed reads — linesCount + lineAt (newest-first) — for the canvas', () => {
	const v = makeView( 'rawlogs:view' );
	v.fill( envelopeMsg( { value: 'a' } ) );
	v.fill( envelopeMsg( { value: 'b' } ) );
	v.fill( envelopeMsg( { value: 'c' } ) );
	expect( v.linesCount ).toBe( 3 );
	expect( v.lineAt( 0 ).content ).toBe( 'c' ); // newest
	expect( v.lineAt( 1 ).content ).toBe( 'b' );
	expect( v.lineAt( 2 ).content ).toBe( 'a' ); // oldest
	expect( v.lineAt( 3 ) ).toBeUndefined(); // out of range
} );

test( 'lineAt + linesCount respect the cap (oldest overwritten) on a small ring', () => {
	const v = new RawLogsViewNode( 3 );
	v.name = 'rawlogs:view';
	for ( let i = 0; i < 10; i++ ) {
		v.fill( envelopeMsg( { value: `line ${ i }` } ) );
	}
	expect( v.linesCount ).toBe( 3 );
	expect( v.lineAt( 0 ).content ).toBe( 'line 9' ); // newest
	expect( v.lineAt( 2 ).content ).toBe( 'line 7' ); // oldest still in cap
} );

test( 'a read mid-stream then more appends keeps newest-first across the coalesce boundary', () => {
	const v = makeView( 'rawlogs:view' );
	v.fill( envelopeMsg( { value: 'a' } ) );
	v.fill( envelopeMsg( { value: 'b' } ) );
	expect( v.lines.map( ( l ) => l.content ) ).toEqual( [ 'b', 'a' ] );
	v.fill( envelopeMsg( { value: 'c' } ) );
	expect( v.lines.map( ( l ) => l.content ) ).toEqual( [ 'c', 'b', 'a' ] );
} );

test( 'LPS tracking aggregates per second, not one entry per line (bounded window)', () => {
	// Perf contract: the lines/second window must NOT grow one entry per
	// line (the old `lineHistory.push`-per-line + full filter+reduce was
	// O(n) per line). A 10s window collapses to per-second buckets, so a
	// burst of 500 synchronous lines stays a handful of buckets — never 500.
	const v = makeView( 'rawlogs:view' );
	for ( let i = 0; i < 500; i++ ) {
		v.fill( envelopeMsg( { value: `row ${ i }` } ) );
	}
	expect( Array.isArray( v.lpsBuckets ) ).toBe( true );
	expect( v.lpsBuckets.length ).toBeLessThanOrEqual( 12 );
} );

test( 'defaults connectionError to false in the published model', () => {
	const v = makeView( 'rawlogs:view' );
	v.fill( controlMsg( { action: 'pause', paused: false } ) );
	expect( v.setStateCache.view.connectionError ).toBe( false );
} );

test( 'a connection control sets connectionError true then false', () => {
	const v = makeView( 'rawlogs:view' );
	v.fill( controlMsg( { action: 'connection', connectionError: true } ) );
	expect( v.connectionError ).toBe( true );
	expect( v.setStateCache.view.connectionError ).toBe( true );
	v.fill( controlMsg( { action: 'connection', connectionError: false } ) );
	expect( v.connectionError ).toBe( false );
	expect( v.setStateCache.view.connectionError ).toBe( false );
} );

test( 'an unrelated control does not change connectionError', () => {
	const v = makeView( 'rawlogs:view' );
	v.fill( controlMsg( { action: 'connection', connectionError: true } ) );
	v.fill( controlMsg( { action: 'pause', paused: true } ) );
	v.fill( envelopeMsg( { value: 'ignored while paused' } ) );
	expect( v.connectionError ).toBe( true );
	expect( v.setStateCache.view.connectionError ).toBe( true );
} );

test( 'names the node', () => {
	const v = makeView( 'rawlogs:view' );
	expect( v.name ).toBe( 'rawlogs:view' );
} );

test( 'fill increments the node counter so the overlay shows throughput', () => {
	const v = makeView( 'rawlogs:view' );
	expect( v.counter ).toBe( 0 );
	v.fill( envelopeMsg( { value: 'line one' } ) );
	v.fill( envelopeMsg( { value: 'line two' } ) );
	expect( v.counter ).toBe( 2 );
} );

test( 'declares has_target:false (terminal receiver — no out-port)', () => {
	expect( RawLogsViewNode.nodeSchema().has_target ).toBe( false );
} );
