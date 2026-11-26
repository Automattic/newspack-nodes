/**
 * schemes — the skins whose controls take `color-scheme: dark`, read from the
 * stylesheet that declares them, and a resolved value read as the branch of
 * each `light-dark()` a scheme takes, which a style test needs before it
 * measures a color the skin resolves.
 */

import fs from 'fs';
import path from 'path';

const { closeOf, splitTopLevel } = require(
	path.join( __dirname, '../../build-kit/css-reader.cjs' )
);

/**
 * The skins `$np-dark-skins` names.
 *
 * @type {string[]}
 */
export const DARK_SKINS = fs
	.readFileSync(
		path.resolve( __dirname, '../styles/_controls.scss' ),
		'utf8'
	)
	.match( /\$np-dark-skins:\s*([^;]+);/ )[ 1 ]
	.split( ',' )
	.map( ( skin ) => skin.trim() );

/**
 * A value with each `light-dark( light, dark )` in it, nested ones too, read
 * as the branch a scheme takes.
 *
 * @param {string}         value  A resolved value.
 * @param {boolean|string} scheme Whether the scheme is dark, or the skin.
 * @return {string} The value with no `light-dark()` left.
 * @throws {Error} When a `light-dark()` never closes.
 */
export function schemed( value, scheme ) {
	const dark =
		'string' === typeof scheme ? DARK_SKINS.includes( scheme ) : scheme;
	const at = value.indexOf( 'light-dark(' );
	if ( -1 === at ) {
		return value;
	}
	const open = at + 'light-dark('.length;
	const close = closeOf( value, open );
	const [ light, darkOne ] = splitTopLevel(
		value.slice( open, close - 1 ),
		( char ) => ',' === char
	);
	return schemed(
		value.slice( 0, at ) +
			( dark ? darkOne : light ) +
			value.slice( close ),
		dark
	);
}
