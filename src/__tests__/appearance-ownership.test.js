/* @jest-environment node */

/**
 * Appearance ownership: the stylesheets paint, the components do not.
 *
 * An inline `style` that carries appearance — a colour, a border, a shadow —
 * paints from JavaScript, where no stylesheet can reach it: the skin cannot
 * retheme it, a media query cannot answer it, and the next reader looking for
 * the rule finds nothing. Geometry inline is fine, because geometry is often
 * computed; appearance is not.
 *
 * Ported from newspack-event-logger-nodes, which has carried this contract for
 * longer. Only the inline half came across — the rest of that file pins
 * stylesheet rules belonging to the Event Logger's own dashboards.
 *
 * An exception goes in ALLOWLIST with the reason. A value the component
 * genuinely computes — a series colour, a gradient over live data — is a real
 * exception; "the stylesheet was inconvenient" is not.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.resolve( __dirname, '..' );

/** Appearance in an inline style object, by property name. */
const INLINE_APPEARANCE_PROPERTY =
	/\b(?:appearance|background(?:[A-Z]\w*)?|border(?:[A-Z]\w*)?|boxShadow|color|cursor|filter|fontFamily|fontWeight|opacity|outline|textDecoration|textTransform|letterSpacing)\s*:/;

/**
 * Deliberate exceptions, by path relative to `src`, each matched against the
 * declaration and the two lines after it.
 *
 * @type {Map<string, RegExp[]>}
 */
const ALLOWLIST = new Map( [
	// A series colour is DATA the chart computed and handed down, not a style
	// choice: the swatch paints whatever rank the series drew.
	[ 'shared/components/ChartLegend.js', [ /background: color/ ] ],
	[
		'shared/hooks/useSeriesSelection.js',
		[ /color: colorAt/, /color: legendItems\[/ ],
	],
] );

/** A comment or a docblock line — prose, not a style object. */
const IS_COMMENT = /^\s*(?:\/\/|\/\*|\*)/;

const walkSource = ( root ) =>
	fs.readdirSync( root, { withFileTypes: true } ).flatMap( ( entry ) => {
		const absolute = path.join( root, entry.name );
		if ( entry.isDirectory() ) {
			return '__tests__' === entry.name ? [] : walkSource( absolute );
		}
		return /\.js$/.test( entry.name ) ? [ absolute ] : [];
	} );

describe( 'appearance ownership', () => {
	it( 'contains no hardcoded inline appearance', () => {
		const offenders = [];

		for ( const file of walkSource( SRC ) ) {
			const relative = path.relative( SRC, file );
			const allowed = ALLOWLIST.get( relative ) || [];
			const lines = fs.readFileSync( file, 'utf8' ).split( '\n' );
			lines.forEach( ( line, index ) => {
				const declaration = lines.slice( index, index + 3 ).join( ' ' );
				if (
					IS_COMMENT.test( line ) ||
					! INLINE_APPEARANCE_PROPERTY.test( line ) ||
					allowed.some( ( pattern ) => pattern.test( declaration ) )
				) {
					return;
				}
				offenders.push( `${ relative }:${ index + 1 }` );
			} );
		}

		expect( offenders ).toEqual( [] );
	} );
} );
