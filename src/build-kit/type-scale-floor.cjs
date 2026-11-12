/**
 * The type scale's floor: no interface text sits below its smallest step,
 * `--np-text-2xs` (12px). Every plugin's floor test reads its compiled
 * stylesheets through `stylesheetOffenders()` and its scripts through
 * `scriptOffenders()`, so the three agree on what a size is.
 *
 * A size is read where it is written: a `font-size`, or a `font` shorthand's
 * size, its line-height after a `/` set aside. `px` counts as written; `rem`
 * and `em` count against a 16px root, so a nested `em` is read as if its
 * parent stood at the root. A script sets type through `fontSize`, a
 * `'font-size'` style or attribute, where a bare number is pixels, a canvas's
 * or a style object's `font` string, or CSS text in a string literal.
 */

const {
	closeOf,
	shorthandSize,
	splitTopLevel,
	words,
} = require( './css-reader.cjs' );

const FLOOR_PX = 12;

// The absolute size keywords under the floor, in pixels.
const KEYWORDS = { 'xx-small': 9, 'x-small': 10 };

// Pixels per unit of each absolute length; rem, em and % read at a 16px root.
const PER_UNIT = {
	'': 1,
	'%': 0.16,
	px: 1,
	rem: 16,
	em: 16,
	pt: 4 / 3,
	pc: 16,
	in: 96,
	cm: 96 / 2.54,
	mm: 96 / 25.4,
	q: 96 / 101.6,
};

// The keywords at or over the floor, and those that set no size of their own.
const NOT_BELOW =
	/^(inherit|initial|unset|revert|revert-layer|medium|small|(xx?x?-)?large|larger|smaller|math)$/i;
const LENGTH = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]*|%)$/i;
const FUNCTION = /^(var|calc|min|max|clamp)\(/i;
// The type scale, at or over the floor by its definition: its one list.
const SCALE_TOKEN = /^--np-text-(2xs|xs|s|m|l|xl)$/;

/**
 * A function filling the whole size, its name lowercased and its arguments cut
 * at top-level commas, or null where the size is not one function closing at
 * its end.
 *
 * @param {string} size One size, as written.
 * @return {?{name: string, args: string[]}} The function.
 */
const functionOf = ( size ) => {
	const open = FUNCTION.exec( size );
	if ( ! open ) {
		return null;
	}
	let close;
	try {
		close = closeOf( size, open[ 0 ].length );
	} catch {
		return null;
	}
	return close === size.length
		? {
				name: open[ 1 ].toLowerCase(),
				args: splitTopLevel(
					size.slice( open[ 0 ].length, -1 ),
					( ch ) => ',' === ch
				),
		  }
		: null;
};

/**
 * Whether a `var()` names a token of the type scale.
 *
 * @param {string} word One word, as written.
 * @return {boolean} Whether it does.
 */
const isScaleVar = ( word ) => {
	const fn = functionOf( word );
	return 'var' === fn?.name && SCALE_TOKEN.test( fn.args[ 0 ] ?? '' );
};

// A size whose least value no sheet reading can know.
const UNREADABLE = 'unreadable';
// A size a token sets, with no fallback to read.
const TOKEN = 'token size';

/**
 * The least pixels a size can take: a length as written, a percentage as an
 * em, a `var()` by its fallback, a token of the type scale as the floor itself,
 * a `clamp()` by its minimum, a `max()` by its largest readable argument, a
 * `min()` by its arguments, a `calc()` of one length. `TOKEN` for a `var()`
 * with no fallback outside the type scale; null for a keyword at or over the
 * floor, or one setting no size of its own; `UNREADABLE` for every other
 * form: another unit, such as a viewport's, a container's or the font's own,
 * a math function past those, any other function, and any other word.
 *
 * @param {string} size One size, as written.
 * @return {number|string|null} Its least pixels, `TOKEN`, `UNREADABLE`, or null.
 */
const pixels = ( size ) => {
	if ( Object.hasOwn( KEYWORDS, size.toLowerCase() ) ) {
		return KEYWORDS[ size.toLowerCase() ];
	}
	if ( NOT_BELOW.test( size ) ) {
		return null;
	}
	const fn = functionOf( size );
	if ( 'var' === fn?.name ) {
		if ( isScaleVar( size ) ) {
			return FLOOR_PX;
		}
		return 1 === fn.args.length
			? TOKEN
			: pixels( fn.args.slice( 1 ).join( ', ' ) );
	}
	if ( fn ) {
		return mathPixels( fn.name, fn.args.map( pixels ) );
	}
	const length = LENGTH.exec( size );
	const unit = length?.[ 2 ].toLowerCase();
	return length && Object.hasOwn( PER_UNIT, unit )
		? Number( length[ 1 ] ) * PER_UNIT[ unit ]
		: UNREADABLE;
};

/**
 * The least pixels a math function's value can take, from its arguments'.
 *
 * @param {string}                    fn   `calc`, `min`, `max` or `clamp`.
 * @param {Array<number|string|null>} args Each argument's least pixels.
 * @return {number|string} Its least pixels, `TOKEN` or `UNREADABLE`.
 */
const mathPixels = ( fn, args ) => {
	if ( 'clamp' === fn && 'number' === typeof args[ 0 ] ) {
		return args[ 0 ];
	}
	const numbers = args.filter( ( px ) => 'number' === typeof px );
	if ( 'max' === fn && numbers.length ) {
		return Math.max( ...numbers );
	}
	const below = numbers.some( ( px ) => px < FLOOR_PX );
	if ( 'min' === fn && ( below || numbers.length === args.length ) ) {
		return Math.min( ...numbers );
	}
	if ( 'calc' === fn && 1 === args.length && numbers.length ) {
		return numbers[ 0 ];
	}
	return args.includes( TOKEN ) ? TOKEN : UNREADABLE;
};

/**
 * How a size reads against the floor.
 *
 * @param {number|string|null} px What `pixels()` answers.
 * @return {?string} `below`, `unreadable`, or null for a size at or over it.
 */
const reading = ( px ) => {
	if ( UNREADABLE === px || TOKEN === px ) {
		return px;
	}
	return 'number' === typeof px && px < FLOOR_PX ? 'below' : null;
};

/**
 * How a `font` or `font-size` declaration's size reads against the floor; a
 * shorthand the reader cannot place reads as unreadable, so a sweep lists
 * every offence rather than stopping at one.
 *
 * @param {string} prop  `font` or `font-size`.
 * @param {string} value Its value.
 * @return {?string} `below`, `unreadable`, or null.
 */
const floorOf = ( prop, value ) => {
	let size;
	try {
		size =
			'font' === prop
				? shorthandSize( value, { isSizeVar: isScaleVar } )
				: value.trim();
	} catch {
		return UNREADABLE;
	}
	return reading( pixels( size ) );
};

/**
 * Whether a `font` or `font-size` declaration sets type below the floor.
 *
 * @param {string} prop  `font` or `font-size`.
 * @param {string} value Its value.
 * @return {boolean} True when the size reads under 12px.
 */
const belowFloor = ( prop, value ) => 'below' === floorOf( prop, value );

// A font string's word that names rather than sizes: a family, weight or style.
const NAME = /^(?:(?:-?[a-z_][\w-]*|"[^"]*"|'[^']*'),?)+$|^\d*\.?\d+$/i;

/**
 * How a script's font text reads against the floor, read leniently: by the
 * first word that reads as a size, a bare number being a weight there; a size
 * left to an interpolation is unreadable, one at or over the floor reads
 * false, and text that is not a font value reads null.
 *
 * @param {string} text The text a script sets as a font or a font size.
 * @return {string|false|null} `below`, `unreadable`, `token size`, false, or null.
 */
const scriptFloor = ( text ) => {
	let unknown = text.includes( '${' ) ? UNREADABLE : null;
	for ( const word of words( text ) ) {
		const [ size = '' ] = splitTopLevel( word, ( ch ) => '/' === ch );
		const named =
			NAME.test( size ) &&
			! Object.hasOwn( KEYWORDS, size.toLowerCase() );
		const px = named ? null : pixels( size );
		if ( 'number' === typeof px ) {
			return reading( px ) ?? false;
		}
		unknown = unknown ?? px;
	}
	return reading( unknown );
};

/**
 * What names a declaration's place: its rule's selector, or the at-rule
 * holding it.
 *
 * @param {import('postcss').Declaration} decl The declaration.
 * @return {string} The selector, or `@<name> <params>`.
 */
const placeOf = ( decl ) => {
	const parent = decl.parent;
	const place =
		parent.selector ?? `@${ parent.name } ${ parent.params ?? '' }`;
	return place.replace( /\s+/g, ' ' ).trim();
};

/**
 * Every declaration in a compiled stylesheet setting type below the floor, or
 * at a size it cannot read.
 *
 * @param {import('postcss').Root} sheet The parsed stylesheet.
 * @param {string}                 label What names the sheet in a line.
 * @return {string[]} `<label>:<place> <prop>: <value>`, one per offence.
 */
const stylesheetOffenders = ( sheet, label ) => {
	const found = [];
	sheet.walkDecls( /^font(-size)?$/, ( decl ) => {
		const floor = floorOf( decl.prop, decl.value );
		if ( floor ) {
			const note = 'below' === floor ? '' : ` (${ floor })`;
			found.push(
				`${ label }:${ placeOf( decl ) } ${ decl.prop }: ${
					decl.value
				}${ note }`
			);
		}
	} );
	return found;
};

// A `fontSize` or `'font-size'` setter: a quoted size, or a bare number of px.
const SIZE_SETTER =
	/(?:['"]?fontSize['"]?\s*[:=]\s*\{?\s*|['"]font-size['"]\s*[,:]\s*)(?:(['"`])([^'"`\n]*)\1(?=\s*(?:[,;)}\]\n]|$))|(\d*\.?\d+)(?![\w.%])(?=\s*(?:[,;)}\]\n]|$))|([^\s,;)}\]][^,;)}\]\n]*))/gm;
// A canvas's `.font =` or an object's `font:` key, quoted or not.
const FONT_SETTER =
	/(?:\.font\s*=|(?<![\w'"`.-])(['"]?)font\1\s*:)\s*(?:(['"`])((?:\\.|(?!\2)[^\\])*)\2(?=\s*(?:[,;)}\]\n]|$))|([^\s,;)}\]][^,;)}\]\n]*))/gm;
// A string literal holding CSS, as a `cssText`; a template one spans lines.
const LITERAL = /'(?:\\.|[^\\'\n])*'|"(?:\\.|[^\\"\n])*"|`(?:\\.|[^\\`])*`/g;
// A font declaration in CSS text, to `;`, `}`, `>`, `!` or an unpaired quote.
const CSS_FONT =
	/(?<![\w-])(font(?:-size)?)\s*:\s*((?:"[^"\n]*"|'[^'\n]*'|[^;}\n"'`<>!])+)/g;

/**
 * Every line of a script setting type below the floor, or at a size it cannot
 * read: through `fontSize`, a `'font-size'` style or attribute, a `font`
 * string, or CSS in a string, each font string read leniently.
 *
 * @param {string} source The script's source.
 * @param {string} label  What names the script in a line.
 * @return {string[]} `<label>:<line>`, one per line holding an offence, in order.
 */
const scriptOffenders = ( source, label ) => {
	const at = [];
	const offend = ( floor, index ) => {
		if ( floor ) {
			at.push( {
				index,
				note: 'below' === floor ? '' : ` (${ floor })`,
			} );
		}
	};
	for ( const match of source.matchAll( SIZE_SETTER ) ) {
		offend(
			undefined === match[ 4 ]
				? reading( pixels( ( match[ 2 ] ?? match[ 3 ] ).trim() ) )
				: UNREADABLE,
			match.index
		);
	}
	for ( const match of source.matchAll( FONT_SETTER ) ) {
		offend(
			undefined === match[ 4 ]
				? scriptFloor( match[ 3 ] )
				: scriptFloor( match[ 4 ] ) ?? UNREADABLE,
			match.index
		);
	}
	for ( const literal of source.matchAll( LITERAL ) ) {
		for ( const css of literal[ 0 ].slice( 1, -1 ).matchAll( CSS_FONT ) ) {
			offend( scriptFloor( css[ 2 ] ), literal.index + 1 + css.index );
		}
	}
	const lines = at
		.sort( ( a, b ) => a.index - b.index )
		.map(
			( { index, note } ) =>
				`${ label }:${
					source.slice( 0, index ).split( '\n' ).length
				}${ note }`
		);
	return [ ...new Set( lines ) ];
};

module.exports = { belowFloor, stylesheetOffenders, scriptOffenders };
