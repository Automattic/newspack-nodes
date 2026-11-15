/**
 * `var_export()` for a Node build: a JavaScript value as PHP source, for the
 * tables a build writes beside its bundles, such as the blocks manifest.
 */

/**
 * Quote a string as a single-quoted PHP literal.
 *
 * @param {string} text Text to quote.
 * @return {string} The literal, backslashes and quotes escaped.
 */
function phpString( text ) {
	return `'${ text.replace( /\\/g, '\\\\' ).replace( /'/g, "\\'" ) }'`;
}

/**
 * Format a JavaScript value as PHP source: long-form `array()`, tab
 * indentation, single-quoted strings and keys with backslashes and quotes
 * escaped. A value PHP arrays cannot carry, such as `undefined` or a
 * function, becomes `NULL`.
 *
 * @param {*}      value    Value to format.
 * @param {string} [indent] Indentation of the line the literal opens on;
 *                          nested levels add a tab to it.
 * @return {string} PHP source for the value.
 */
export function phpExport( value, indent = '\t' ) {
	if ( null === value ) {
		return 'NULL';
	}
	if ( 'boolean' === typeof value ) {
		return value ? 'true' : 'false';
	}
	if ( 'number' === typeof value ) {
		return String( value );
	}
	if ( 'string' === typeof value ) {
		return phpString( value );
	}
	if ( 'object' !== typeof value ) {
		return 'NULL';
	}
	const rows = Array.isArray( value )
		? value.map( ( v ) => phpExport( v, indent + '\t' ) )
		: Object.keys( value ).map(
				( k ) =>
					`${ phpString( k ) } => ${ phpExport(
						value[ k ],
						indent + '\t'
					) }`
		  );
	const inner = rows.length
		? rows.map( ( row ) => `${ indent }\t${ row }` ).join( ',\n' )
		: `${ indent }\t`;
	return `array(\n${ inner }\n${ indent })`;
}
