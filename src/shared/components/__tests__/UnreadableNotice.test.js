/**
 * UnreadableNotice tests — the shared error banner a view shows for each
 * failure the server answered beside a partial reply: a topology that will
 * not read, or a log producer the catalog left out.
 */

import { render } from '@testing-library/react';
import UnreadableNotice from '../UnreadableNotice';

describe( 'UnreadableNotice', () => {
	it( 'renders one canonical error banner per failure, naming it and why', () => {
		const { container } = render(
			<UnreadableNotice
				failures={ {
					'marmot-6610': 'include orphaned-6611 resolves no .tsl',
					'vole-6612': "unknown topology 'vole-6612'",
				} }
				describe={ ( name, message ) =>
					`Topology ${ name } is out: ${ message }`
				}
			/>
		);
		const banners = [
			...container.querySelectorAll( '.newspack-nodes-error-banner' ),
		];
		expect( banners.map( ( b ) => b.textContent ) ).toEqual( [
			'Topology marmot-6610 is out: include orphaned-6611 resolves no .tsl',
			"Topology vole-6612 is out: unknown topology 'vole-6612'",
		] );
		banners.forEach( ( b ) =>
			expect( b.getAttribute( 'role' ) ).toBe( 'status' )
		);
	} );

	// PHP encodes an empty map as a JSON list, so [] arrives too.
	it.each( [ {}, [], undefined ] )(
		'renders nothing for %p',
		( failures ) => {
			const { container } = render(
				<UnreadableNotice failures={ failures } describe={ String } />
			);
			expect( container.childNodes.length ).toBe( 0 );
		}
	);
} );
