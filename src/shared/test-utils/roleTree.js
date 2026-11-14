/**
 * roleTree — a page as a reader of its accessibility tree meets it: each
 * element carrying a role other than a generic one, by its role and its
 * accessible name, and each run of text, in document order and indented by
 * how many roled elements hold it. Two pages built of different wrappers
 * read alike when they show the same things in the same order.
 *
 * A subtree a reader never meets, `aria-hidden` or `hidden`, is left out.
 */

/* eslint-env jest */
import { getRoles } from '@testing-library/react';
// Testing Library installs the name computation its own queries read.
// eslint-disable-next-line import/no-extraneous-dependencies
import { computeAccessibleName } from 'dom-accessibility-api';

/** The roles a wrapper takes, which a reader does not meet as a thing. */
const WRAPPERS = new Set( [ 'generic', 'presentation', 'none' ] );

/**
 * The page under `container` as lines, one per roled element or run of text.
 *
 * @param {HTMLElement} container The page.
 * @return {string} The tree.
 */
export function roleTree( container ) {
	const roleOf = new Map();
	for ( const [ role, elements ] of Object.entries(
		getRoles( container )
	) ) {
		for ( const element of elements ) {
			if ( ! roleOf.has( element ) ) {
				roleOf.set( element, role );
			}
		}
	}
	const lines = [];
	const walk = ( node, depth ) => {
		if ( 3 === node.nodeType ) {
			const text = node.textContent.replace( /\s+/g, ' ' ).trim();
			if ( text ) {
				lines.push( `${ '  '.repeat( depth ) }"${ text }"` );
			}
			return;
		}
		if ( 1 !== node.nodeType ) {
			return;
		}
		if (
			'true' === node.getAttribute( 'aria-hidden' ) ||
			node.hasAttribute( 'hidden' )
		) {
			return;
		}
		const role = roleOf.get( node );
		let inner = depth;
		if ( role && ! WRAPPERS.has( role ) ) {
			const name = computeAccessibleName( node );
			lines.push(
				`${ '  '.repeat( depth ) }${ role }${
					name ? ` "${ name }"` : ''
				}`
			);
			inner = depth + 1;
		}
		node.childNodes.forEach( ( child ) => walk( child, inner ) );
	};
	container.childNodes.forEach( ( child ) => walk( child, 0 ) );
	return lines.join( '\n' );
}
