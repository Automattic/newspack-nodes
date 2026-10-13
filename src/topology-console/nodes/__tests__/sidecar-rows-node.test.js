/**
 * SidecarRowsNode — which names its rows answer, across replies and asks.
 */

import { SidecarRowsNode } from '../sidecar-rows-node';

/** `dump_metadata -o vat-2290`: the vat, and the lid it lists. */
const VAT = {
	'vat-2290': {
		class: 'Node',
		sidecars: [
			{ name: 'vat-2290:lid', class: 'Table' },
			{ name: 'vat-2290:tap', class: 'Tee' },
		],
	},
	'vat-2290:lid': { class: 'Table', counter: 8125, owner: 'vat-2290' },
};

describe( 'SidecarRowsNode', () => {
	it( 'counts each owner asked, and each sidecar it lists, answered', () => {
		const node = new SidecarRowsNode();
		node.ask( [ '-o', 'vat-2290', 'ghost-8810' ], 'vat-2290 ghost-8810' );
		expect( node.answered ).toEqual( [] );
		expect( node.metadata ).toBeNull();
		node.publish( VAT );
		expect( node.answered ).toEqual( [
			'vat-2290',
			'ghost-8810',
			'vat-2290:lid',
			'vat-2290:tap',
		] );
	} );

	it( 'leaves what it answers alone for a reply it cannot read', () => {
		const node = new SidecarRowsNode();
		node.ask( [ '-o', 'vat-2290' ], 'vat-2290' );
		node.publish( VAT );
		node.ask( [ '-o', 'vat-2290', 'crawl-4471' ], 'vat-2290 crawl-4471' );
		node.publish( 'not json' );
		expect( node.answered ).toEqual( [
			'vat-2290',
			'vat-2290:lid',
			'vat-2290:tap',
		] );
		expect( node.metadata.nodes.map( ( n ) => n.id ) ).toEqual( [
			'vat-2290',
			'vat-2290:lid',
		] );
	} );

	it( 'keeps across an owner change only what the new owners cover', () => {
		const node = new SidecarRowsNode();
		node.ask( [ '-o', 'vat-2290' ], 'vat-2290' );
		node.publish( VAT );
		node.ask( [ '-o', 'vat-2290:lid' ], 'vat-2290:lid' );
		expect( node.answered ).toEqual( [ 'vat-2290:lid' ] );
		expect( Object.keys( node.rawMap ) ).toEqual( [ 'vat-2290:lid' ] );
		expect( node.metadata.nodes[ 0 ].count ).toBe( 8125 );
	} );
} );
