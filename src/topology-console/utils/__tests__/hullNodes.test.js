/**
 * A hull's stats are its MEMBERS' stats — so the member selector is what scopes
 * every rate the panel shows. Getting it wrong shows the whole graph's traffic
 * under one include's name.
 */
import { hullNodes } from '../hullNodes';

describe( 'hullNodes', () => {
	const nodes = [
		{ id: 'request-builder', count: 71 },
		{ id: 'shared-tee', count: 33 },
		{ id: 'own-echo', count: 12 },
	];
	const hulls = [
		{
			include: 'performance',
			nodeIds: [ 'request-builder', 'shared-tee' ],
		},
		{ include: 'job-router', nodeIds: [ 'shared-tee' ] },
	];

	it( 'returns only the nodes the named include provides', () => {
		expect( hullNodes( nodes, hulls, 'performance' ) ).toEqual( [
			{ id: 'request-builder', count: 71 },
			{ id: 'shared-tee', count: 33 },
		] );
	} );

	it( 'is empty for no selection, so the hook sees no scope', () => {
		expect( hullNodes( nodes, hulls, null ) ).toEqual( [] );
	} );

	it( 'is empty for an include with no hull on the canvas', () => {
		expect( hullNodes( nodes, hulls, 'not-drawn' ) ).toEqual( [] );
	} );

	it( 'keeps the same array identity across calls, so the rate hook is stable', () => {
		expect( hullNodes( nodes, hulls, null ) ).toBe(
			hullNodes( nodes, hulls, 'not-drawn' )
		);
	} );
} );
