/**
 * LogViewerViewNode tests — the Log Viewer's raw-line ring. It reuses the
 * Partition Viewer view's O(1) ring; a raw log line (VALUE, no KEY, one source)
 * shapes to a partition-0 row, and the schema stays a hidden render sink.
 */

import {
	FROM,
	VALUE,
	TYPE,
	TM_BYTESTREAM,
	newMessage,
} from '../../../runtime/message';
import { Core } from '../../../runtime/core';
import { LogViewerViewNode } from '../logviewer-view-node';

beforeEach( () => Core.reset() );

it( 'shapes a raw log line into a partition-0 ring row', () => {
	const node = new LogViewerViewNode();
	node.name = 'logviewer:view';
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ FROM ] = 'php';
	m[ VALUE ] = '[error] something broke';
	node.fill( m );
	expect( node.lines ).toHaveLength( 1 );
	expect( node.lines[ 0 ].content ).toBe( '[error] something broke' );
	expect( node.lines[ 0 ].partition ).toBe( 0 );
} );

it( 'declares a hidden render-model schema of its own', () => {
	const schema = LogViewerViewNode.nodeSchema();
	expect( schema.category ).toBe( 'Hidden' );
	expect( schema.has_target ).toBe( false );
	expect( schema.description ).toMatch( /Log Viewer/ );
} );
