/**
 * autoLayout over newspack-intelligence's worker as the console paints it
 * once the worker answers: the `dump_metadata` a live install answered,
 * composed with its `classes dump` catalog. Two Consumers feed
 * the resolver, which feeds the extractor and then the deduper; every one of
 * the last three writes to `intel:writer`, the hub the sources fan into. Below,
 * the ontology Consumer's Tee and the items Consumer feed the projector.
 */

import { autoLayout } from '../autoLayout';
import { augmentWithVirtualEdges } from '../virtualEdges';
import { parseMetadata } from '../../../runtime/metadata-node';
import LIVE from './fixtures/intelligence-metadata.json';

/**
 * Lay the live graph out.
 *
 * @return {Object<string,{x: number, y: number}>} Position by id.
 */
const layOut = () =>
	Object.fromEntries(
		autoLayout(
			augmentWithVirtualEdges(
				parseMetadata( LIVE.metadata ),
				LIVE.classes
			)
		).nodes.map( ( n ) => [ n.id, n.position ] )
	);

describe( 'autoLayout — the newspack-intelligence worker', () => {
	it( 'seats the extractor level with the first Consumer, above the resolver', () => {
		const at = layOut();
		expect( at.extractor.y ).toBe( at[ 'intel:items:resolve' ].y );
		expect( at.extractor.y ).toBeLessThan( at.resolver.y );
	} );

	it( 'seats the items Consumer above the ontology Tee, the projector between', () => {
		const at = layOut();
		const consumer = at[ 'intel:items:consumer' ].y;
		const tee = at[ 'intel:ontology:tee' ].y;
		expect( at[ 'intel:items:consumer' ].x ).toBe(
			at[ 'intel:ontology:tee' ].x
		);
		expect( consumer ).toBeLessThan( at.projector.y );
		expect( at.projector.y ).toBeLessThan( tee );
		expect( at[ 'intel-graph' ].y ).toBe( at.projector.y );
		expect( at.reresolver.y ).toBeGreaterThan( tee );
		expect( at[ 'intel:reresolve' ].y ).toBe( at.reresolver.y );
	} );
} );
