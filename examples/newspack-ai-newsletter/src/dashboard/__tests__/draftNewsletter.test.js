/**
 * draftNewsletter — the client-side items → markdown render (NO server call).
 * Pure function so the "Draft newsletter" button just feeds it the live model's
 * top items.
 */

import { draftNewsletter } from '../draftNewsletter';

describe( 'draftNewsletter', () => {
	it( 'renders a markdown heading and one bullet per item', () => {
		const md = draftNewsletter( [
			{ source: 'releases', title: 'New release', score: 9 },
			{ source: 'community', title: 'A thread', score: 4 },
		] );
		expect( md ).toContain( '# ' );
		expect( md ).toContain( '- **New release**' );
		expect( md ).toContain( '- **A thread**' );
		expect( md ).toContain( 'releases' );
		expect( md ).toContain( 'community' );
	} );

	it( 'orders bullets as given (the model is already score-ranked)', () => {
		const md = draftNewsletter( [
			{ source: 'a', title: 'First', score: 9 },
			{ source: 'b', title: 'Second', score: 1 },
		] );
		expect( md.indexOf( 'First' ) ).toBeLessThan( md.indexOf( 'Second' ) );
	} );

	it( 'returns just the heading for an empty item list', () => {
		const md = draftNewsletter( [] );
		expect( md ).toContain( '# ' );
		expect( md ).not.toContain( '- ' );
	} );

	it( 'tolerates a missing title or source without throwing', () => {
		expect( () => draftNewsletter( [ { score: 3 } ] ) ).not.toThrow();
		const md = draftNewsletter( [ { score: 3 } ] );
		expect( md ).toContain( '- ' );
	} );
} );
