/**
 * clusterLayout — position one include's nodes as a cohesive cluster,
 * translated so the cluster's top-left corner lands on the drop point.
 */

import { clusterLayout } from '../clusterLayout';

describe( 'clusterLayout', () => {
	it( 'lays out one include cohesively and translates it to the drop point', () => {
		const nodes = [
			{ name: 'a-in', class: 'Echo', origin: [ 'performance' ] },
			{ name: 'b-out', class: 'Echo', origin: [ 'performance' ] },
			{ name: 'other', class: 'Echo', origin: [ 'job-router' ] },
		];
		const edges = [
			{ from: 'a-in', to: 'b-out', origin: [ 'performance' ] },
		];

		const pos = clusterLayout( nodes, edges, 'performance', {
			x: 500,
			y: 300,
		} );

		expect( Object.keys( pos ).sort() ).toEqual( [ 'a-in', 'b-out' ] );
		const minX = Math.min( ...Object.values( pos ).map( ( p ) => p.x ) );
		const minY = Math.min( ...Object.values( pos ).map( ( p ) => p.y ) );
		expect( minX ).toBe( 500 );
		expect( minY ).toBe( 300 );
		// Left-to-right: the source sits left of its target.
		expect( pos[ 'a-in' ].x ).toBeLessThan( pos[ 'b-out' ].x );
	} );

	it( 'returns an empty map when the include contributes no nodes', () => {
		const nodes = [
			{ name: 'other', class: 'Echo', origin: [ 'job-router' ] },
		];
		const pos = clusterLayout( nodes, [], 'performance', {
			x: 500,
			y: 300,
		} );
		expect( pos ).toEqual( {} );
	} );

	it( 'skips a node that already has a position (diamond-shared with a prior include)', () => {
		const nodes = [
			{
				name: 'shared-tee',
				class: 'Tee',
				origin: [ 'performance', 'job-router' ],
			},
			{ name: 'router-only', class: 'Echo', origin: [ 'job-router' ] },
		];
		// A position distinct from anything clusterLayout itself would compute.
		const positioned = { 'shared-tee': { x: 42, y: 17 } };

		const pos = clusterLayout(
			nodes,
			[],
			'job-router',
			{ x: 500, y: 300 },
			positioned
		);

		expect( Object.keys( pos ) ).toEqual( [ 'router-only' ] );
	} );
} );
