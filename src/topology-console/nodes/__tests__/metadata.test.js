/**
 * Metadata node tests — the `_metadata` node. `_router` delivers the
 * dump_metadata poll reply (a POSITIONAL Message); the node parses the graph
 * and publishes it for the canvas ( useNodeState( '_metadata', 'metadata' ) ).
 * Never touches the transcript.
 */

import { Metadata } from '../metadata';
import { Node } from '../../../runtime/node';
import {
	newMessage,
	TYPE,
	VALUE,
	TM_STRUCT,
	TM_COMMAND,
	TM_RESPONSE,
} from '../../../runtime/message';

function msg( type, value ) {
	const m = newMessage();
	m[ TYPE ] = type;
	m[ VALUE ] = value;
	return m;
}

describe( 'Metadata node', () => {
	it( 'parses a bare dump_metadata struct VALUE into the metadata state', () => {
		const node = new Metadata();
		node.fill(
			msg( TM_STRUCT, {
				n1: { class: 'Echo', counter: 5, target: 'n2' },
				n2: { class: 'Echo', counter: 3, target: '' },
			} )
		);
		const meta = node.setStateCache.metadata;
		expect( meta.nodes ).toHaveLength( 2 );
		expect( meta.edges ).toEqual( [ { from: 'n1', to: 'n2' } ] );
	} );

	it( 'unwraps a {name,payload} command-response envelope', () => {
		const node = new Metadata();
		node.fill(
			// eslint-disable-next-line no-bitwise
			msg( TM_COMMAND | TM_RESPONSE, {
				name: 'dump_metadata',
				payload: { n1: { class: 'Echo', counter: 7, target: '' } },
			} )
		);
		expect( node.setStateCache.metadata.nodes ).toHaveLength( 1 );
	} );

	it( 'ignores an empty / null payload (no canvas churn)', () => {
		const node = new Metadata();
		node.fill( msg( TM_STRUCT, '' ) );
		node.fill( msg( TM_STRUCT, null ) );
		expect( node.setStateCache.metadata ).toBeUndefined();
	} );

	it( 'pre-declares the `metadata` event so useNodeState can subscribe', () => {
		const node = new Metadata();
		expect( node.registrations.metadata ).toBeDefined();
	} );

	it( 'works as a real sink target (router → metadata.fill)', () => {
		const node = new Metadata();
		const router = new Node();
		router.sink = node;
		router.fill(
			msg( TM_STRUCT, { n1: { class: 'Echo', counter: 1, target: '' } } )
		);
		expect( node.setStateCache.metadata.nodes ).toHaveLength( 1 );
	} );

	it( 'increments the base Node counter on each fill', () => {
		const node = new Metadata();
		node.fill( msg( TM_STRUCT, { n1: { class: 'Echo' } } ) );
		node.fill( msg( TM_STRUCT, { n1: { class: 'Echo' } } ) );
		expect( node.counter ).toBe( 2 );
	} );
} );
