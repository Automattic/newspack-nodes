/**
 * newsletterPost — the client-side items → WordPress draft-post shape (no server
 * call). Pure function feeding the "Create draft post" action: returns the
 * { title, content } the REST `POST /wp/v2/posts` body needs.
 */

import { newsletterPost } from '../newsletterPost';

describe( 'newsletterPost', () => {
	it( 'returns a title and an HTML list with one item per top entry', () => {
		const post = newsletterPost( [
			{ source: 'releases', title: 'New release', score: 9 },
			{ source: 'community', title: 'A thread', score: 4 },
		] );
		expect( typeof post.title ).toBe( 'string' );
		expect( post.title.length ).toBeGreaterThan( 0 );
		expect( post.content ).toContain( '<ul>' );
		expect( post.content ).toContain( '</ul>' );
		expect( post.content ).toContain( '<strong>New release</strong>' );
		expect( post.content ).toContain( '<strong>A thread</strong>' );
		expect( post.content ).toContain( 'releases' );
		expect( post.content ).toContain( 'community' );
	} );

	it( 'preserves the given (already score-ranked) order', () => {
		const post = newsletterPost( [
			{ source: 'a', title: 'First', score: 9 },
			{ source: 'b', title: 'Second', score: 1 },
		] );
		expect( post.content.indexOf( 'First' ) ).toBeLessThan(
			post.content.indexOf( 'Second' )
		);
	} );

	it( 'returns an empty list for no items', () => {
		const post = newsletterPost( [] );
		expect( post.content ).toContain( '<ul>' );
		expect( post.content ).not.toContain( '<li>' );
	} );

	it( 'tolerates a missing title or source without throwing', () => {
		expect( () => newsletterPost( [ { score: 3 } ] ) ).not.toThrow();
		const post = newsletterPost( [ { score: 3 } ] );
		expect( post.content ).toContain( '<li>' );
	} );

	it( 'escapes HTML in titles and sources so markup cannot break out', () => {
		const post = newsletterPost( [
			{ source: 'a<b>', title: 'X & <script>', score: 1 },
		] );
		expect( post.content ).not.toContain( '<script>' );
		expect( post.content ).toContain( '&lt;script&gt;' );
		expect( post.content ).toContain( '&amp;' );
	} );
} );
