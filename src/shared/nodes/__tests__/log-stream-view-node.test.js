/**
 * LogStreamViewNode tests — the shared view-node base every log-stream
 * dashboard's view node extends (Partition/Log Viewer here; ELN's Request Log
 * and Error Log downstream). Owns the O(1) ring, the paused belt + step
 * budget, the decaying lps readout, seek tracking, reply settling, and the
 * shared control verbs. Subclasses supply `shapeRow()` + extra controls.
 */

import { LogStreamViewNode } from '../log-stream-view-node';
import {
	newMessage,
	TYPE,
	KEY,
	VALUE,
	ID,
	TM_STRUCT,
	TM_BYTESTREAM,
} from '../../../runtime/message';

// Minimal concrete subclass: VALUE string becomes the row content.
class TestViewNode extends LogStreamViewNode {
	shapeRow( message ) {
		const value = message[ VALUE ];
		if ( 'string' !== typeof value || '' === value ) {
			return null;
		}
		return {
			content: value,
			msgId: 'string' === typeof message[ ID ] ? message[ ID ] : '',
			key: 'string' === typeof message[ KEY ] ? message[ KEY ] : '',
		};
	}
}

const rowMsg = ( value, id = '' ) => {
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ VALUE ] = value;
	m[ ID ] = id;
	return m;
};

const controlMsg = ( value ) => {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ VALUE ] = value;
	return m;
};

function makeView( maxLines ) {
	const v = new TestViewNode( maxLines );
	v.setStateCache = {};
	v.setState = function ( event, payload ) {
		this.setStateCache[ event ] = payload;
	};
	return v;
}

test( 'rows land in the ring newest-first with monotonic ids', () => {
	const v = makeView();
	v.fill( rowMsg( 'first' ) );
	v.fill( rowMsg( 'second' ) );
	expect( v.linesCount ).toBe( 2 );
	expect( v.lineAt( 0 ).content ).toBe( 'second' );
	expect( v.lineAt( 1 ).content ).toBe( 'first' );
	expect( v.lineAt( 0 ).id ).toBe( 2 );
} );

test( 'the ring caps at maxLines, overwriting the oldest', () => {
	const v = makeView( 3 );
	[ 'a', 'b', 'c', 'd' ].forEach( ( x ) => v.fill( rowMsg( x ) ) );
	expect( v.linesCount ).toBe( 3 );
	expect( v.lines.map( ( r ) => r.content ) ).toEqual( [ 'd', 'c', 'b' ] );
} );

test( 'shapeRow returning null drops the message', () => {
	const v = makeView();
	v.fill( rowMsg( '' ) );
	expect( v.linesCount ).toBe( 0 );
} );

test( 'pause stops appends; a step budget admits exactly N', () => {
	const v = makeView();
	v.fill( controlMsg( { action: 'pause', paused: true } ) );
	v.fill( rowMsg( 'dropped' ) );
	expect( v.linesCount ).toBe( 0 );
	v.fill( controlMsg( { action: 'step', frames: 2 } ) );
	v.fill( rowMsg( 'stepped-1' ) );
	v.fill( rowMsg( 'stepped-2' ) );
	v.fill( rowMsg( 'over-budget' ) );
	expect( v.lines.map( ( r ) => r.content ) ).toEqual( [
		'stepped-2',
		'stepped-1',
	] );
} );

test( 'browse clears the ring (rewinds start clean); follow keeps it', () => {
	const v = makeView();
	v.fill( rowMsg( 'stale' ) );
	v.fill( controlMsg( { action: 'browse', endSegment: 4, endOffset: 70 } ) );
	expect( v.linesCount ).toBe( 0 );
	v.fill( rowMsg( 'kept' ) );
	v.fill( controlMsg( { action: 'follow' } ) );
	expect( v.linesCount ).toBe( 1 );
} );

test( 'lps decays to zero when the stream goes quiet', () => {
	const nowSpy = jest.spyOn( Date, 'now' ).mockReturnValue( 700000 );
	const v = makeView();
	for ( let i = 0; i < 100; i++ ) {
		v.fill( rowMsg( `l-${ i }` ) );
	}
	expect( v.lps ).toBeGreaterThan( 0 );
	nowSpy.mockReturnValue( 715000 );
	expect( v.lps ).toBe( 0 );
	nowSpy.mockRestore();
} );

test( 'seek breadcrumbs publish mode + lastReceivedSegment', () => {
	const v = makeView();
	v.fill( rowMsg( 'x', '3:120:44' ) );
	expect( v.setStateCache.view.lastReceivedSegment ).toBe( 3 );
	expect( v.setStateCache.view.mode ).toBe( 'live' );
} );

test( 'the partition subclass shapes a bare VALUE column beside the key', () => {
	// Pinned here because the Key | Value columns render from row.value.
	// eslint-disable-next-line import/no-relative-packages
	const {
		PartitionViewerViewNode,
	} = require( '../../../event-dashboards/nodes/partition-viewer-view-node' );
	const v = new PartitionViewerViewNode();
	v.setState = () => {};
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ KEY ] = 'jobstats';
	m[ VALUE ] = '{"n":4}';
	const row = v.shapeRow( m );
	expect( row.key ).toBe( 'jobstats' );
	expect( row.value ).toBe( '{"n":4}' );
	expect( row.content ).toBe( 'jobstats: {"n":4}' );
} );

// A verb reply is addressed to the node that asked for it. One reaching this
// node is not its business — and must not become a row in the stream.
test( 'a command reply is ignored, never rendered as a row', () => {
	const v = makeView();

	v.fill( controlMsg( { name: 'list_logs', payload: [ 'x' ] } ) );

	expect( v.linesCount ).toBe( 0 );
} );
