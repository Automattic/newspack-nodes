/**
 * The one reading of compiled CSS the plugins' style tests share: a value's
 * words, a `var()` resolved against a set of tokens, a selector's weight, and
 * the value a longhand wins on an element.
 *
 * `winning()` competes every shorthand and alias that sets the longhand in
 * the families it models: padding and margin sides; border sides' and the
 * outline's colour, width and style; background colour and image; the font's
 * size, family, weight, style and line-height; inline size; and `appearance`
 * with its prefixed alias. Logical properties map onto physical sides as on a
 * horizontal, left-to-right page. Asking for a shorthand or alias the model
 * covers throws, naming the longhands to ask instead. A shorthand in `SETS`,
 * outside the model, that sets the asked longhand on the element throws, and
 * so does one of its longhands when the shorthand is asked; a shorthand whose
 * parts a `var()` leaves ambiguous throws too. A value it cannot model never
 * reads as a pass.
 *
 * It ranks an `!important` declaration above every normal one, then weight,
 * then source order across the sheets in the order given. It reads top-level
 * rules alone: a rule inside an at-rule (jsdom has no viewport to answer a
 * `@media`) and a pseudo-element's rule never reach the element. A selector
 * the DOM cannot read throws, naming it. `options.hovered` names the element
 * the pointer rests on, so `:hover` matches it and its ancestors; without it,
 * `:hover` reads jsdom's own pointer.
 *
 * `computed()` resolves the custom properties a value reads where the cascade
 * sets them, falling back as the browser does, and throws on a cycle.
 */

const {
	selectorSpecificity,
	compare,
} = require( '@csstools/selector-specificity' );
const selectorParser = require( 'postcss-selector-parser' );

/**
 * The one scanner every reading of a value walks: each character from `from`
 * on, with the parenthesis depth after it and whether a quoted string, its
 * quotes included, holds it.
 *
 * @param {string} value The value.
 * @param {number} from  Where to start.
 * @param {number} depth The depth at `from`.
 * @yield {{ch: string, at: number, depth: number, quoted: boolean}} Each character.
 */
function* scan( value, from = 0, depth = 0 ) {
	let quote = null;
	for ( let at = from; at < value.length; at += 1 ) {
		const ch = value[ at ];
		const opens = null === quote && ( '"' === ch || "'" === ch );
		const quoted = null !== quote || opens;
		if ( opens ) {
			quote = ch;
		} else if ( null !== quote ) {
			quote = ch === quote ? null : quote;
		} else {
			depth += { '(': 1, ')': -1 }[ ch ] ?? 0;
		}
		yield { ch, at, depth, quoted };
	}
}

/**
 * A value cut at each top-level occurrence of a separator, one outside every
 * parenthesis and quote, each piece as written, empty ones kept.
 *
 * @param {string}                      value       The value.
 * @param {function( string ): boolean} isSeparator Whether a character cuts.
 * @return {string[]} The pieces.
 */
const cutTopLevel = ( value, isSeparator ) => {
	const pieces = [ '' ];
	for ( const { ch, depth, quoted } of scan( value ) ) {
		if ( ! quoted && 0 === depth && isSeparator( ch ) ) {
			pieces.push( '' );
		} else {
			pieces[ pieces.length - 1 ] += ch;
		}
	}
	return pieces;
};

/**
 * A value cut at each top-level occurrence of a separator: one that sits
 * outside every parenthesis and quote.
 *
 * @param {string}                      value       The value.
 * @param {function( string ): boolean} isSeparator Whether a character cuts.
 * @return {string[]} The pieces, trimmed, the empty ones dropped.
 */
const splitTopLevel = ( value, isSeparator ) =>
	cutTopLevel( value, isSeparator )
		.map( ( piece ) => piece.trim() )
		.filter( Boolean );

/**
 * A value's words, split on whitespace outside parentheses and quotes.
 *
 * @param {string} value A declaration value.
 * @return {string[]} Its words.
 */
const words = ( value ) => splitTopLevel( value, ( ch ) => /\s/.test( ch ) );

/**
 * Where a parenthesized run opened just before `from` closes.
 *
 * @param {string} value The value.
 * @param {number} from  The index just past the opening parenthesis.
 * @return {number} The index just past the closing parenthesis.
 * @throws {Error} When the run never closes, naming the function it opens.
 */
const closeOf = ( value, from ) => {
	for ( const { ch, at, depth, quoted } of scan( value, from, 1 ) ) {
		if ( ! quoted && ')' === ch && 0 === depth ) {
			return at + 1;
		}
	}
	const name = /[\w-]*$/.exec( value.slice( 0, from - 1 ) )[ 0 ];
	throw new Error( `css-reader: unclosed ${ name }() in ${ value }` );
};

/**
 * A value with each `var()` outside a quoted string and a longer name, in any
 * case,
 * replaced by what `replace` answers for it, or left as written where it
 * answers undefined. The fallback reaches `replace` as written, past the
 * first comma and its leading space, empty for `var(--a,)` and null for none.
 *
 * @param {string}                                          value   A declaration value.
 * @param {function( string, ?string ): (string|undefined)} replace Given the name and the fallback.
 * @return {string} The value.
 * @throws {Error} When a `var()` is unclosed or names no custom property.
 */
const replaceVars = ( value, replace ) => {
	let out = '';
	let resume = 0;
	for ( const { ch, at, quoted } of scan( value ) ) {
		if ( at < resume ) {
			continue;
		}
		if (
			quoted ||
			'var(' !== value.slice( at, at + 4 ).toLowerCase() ||
			/[\w-]/.test( value[ at - 1 ] ?? '' )
		) {
			out += ch;
			continue;
		}
		const close = closeOf( value, at + 4 );
		const [ head, ...fallback ] = cutTopLevel(
			value.slice( at + 4, close - 1 ),
			( c ) => ',' === c
		);
		const name = head.trim();
		if ( ! /^--[\w-]+$/.test( name ) ) {
			throw new Error(
				`css-reader: ${ value } holds a var() naming no custom property`
			);
		}
		const used = replace(
			name,
			fallback.length ? fallback.join( ',' ).replace( /^\s+/, '' ) : null
		);
		out += undefined === used ? value.slice( at, close ) : used;
		resume = close;
	}
	return out;
};

/**
 * A refusal naming a custom property that reaches itself.
 *
 * @param {string}   name The property.
 * @param {string[]} seen The properties read on the way to it.
 * @return {Error} The refusal.
 */
const cycle = ( name, seen ) =>
	new Error(
		`css-reader: ${ name } reads itself through ${ [ ...seen, name ].join(
			' > '
		) }`
	);

// An unset `var()` with no fallback: the value is invalid at computed time.
const GUARANTEED_INVALID = Symbol( 'guaranteed-invalid' );

/**
 * A value with every `var()` resolved through `lookup`, the one resolver.
 * `lookup( name )` answers the value a custom property holds, the lookup that
 * resolves that value, and whether its chain starts afresh, or undefined
 * when every layer leaves the property unset. An unset property, and one whose
 * own value is invalid, take the `var()`'s fallback; with none, the whole
 * value is `GUARANTEED_INVALID`.
 *
 * @param {string}                                                                            value  A declaration value.
 * @param {function( string ): ({value: string, lookup: Function, fresh: boolean}|undefined)} lookup Where a property's value is found.
 * @param {string[]}                                                                          seen   The properties read on the way here.
 * @return {string|symbol} The value, resolved, or `GUARANTEED_INVALID`.
 * @throws {Error} Naming a custom property that reaches itself.
 */
const resolveWith = ( value, lookup, seen = [] ) => {
	let invalid = false;
	const out = replaceVars( value, ( name, fallback ) => {
		if ( seen.includes( name ) ) {
			throw cycle( name, seen );
		}
		const found = lookup( name );
		if ( found ) {
			const held = resolveWith(
				found.value,
				found.lookup,
				found.fresh ? [ name ] : [ ...seen, name ]
			);
			if ( GUARANTEED_INVALID !== held ) {
				return held;
			}
		}
		const back =
			null === fallback
				? GUARANTEED_INVALID
				: resolveWith( fallback, lookup, seen );
		if ( GUARANTEED_INVALID !== back ) {
			return back;
		}
		invalid = true;
		return '';
	} );
	return invalid ? GUARANTEED_INVALID : out;
};

/**
 * A value with every `var()` resolved against `env`, the custom properties in
 * force, through `resolveWith()`.
 *
 * @param {string}                 value A declaration value.
 * @param {Object<string, string>} env   The custom properties in force.
 * @return {string|symbol} The value, resolved, or `GUARANTEED_INVALID`.
 * @throws {Error} Naming a custom property that reaches itself.
 */
const resolveVars = ( value, env ) => {
	const lookup = ( name ) =>
		name in env ? { value: env[ name ], lookup, fresh: false } : undefined;
	return resolveWith( value, lookup );
};

/**
 * A selector's weight, `{ a, b, c }`, as `@csstools/selector-specificity`
 * reads it.
 *
 * @param {string} selector One complex selector.
 * @return {{a: number, b: number, c: number}} Its weight.
 */
const WEIGHTS = new Map();
const specificity = ( selector ) => {
	if ( ! WEIGHTS.has( selector ) ) {
		WEIGHTS.set(
			selector,
			selectorSpecificity( selectorParser().astSync( selector ).first )
		);
	}
	return WEIGHTS.get( selector );
};

const isVar = ( word ) => /^var\(/i.test( word );

/**
 * A refusal naming a shorthand whose parts a `var()` leaves ambiguous.
 *
 * @param {string} property The shorthand.
 * @param {string} value    Its value.
 * @param {string} part     The part asked for.
 * @return {Error} The refusal.
 */
const ambiguous = ( property, value, part ) =>
	new Error(
		`css-reader: ${ property }: ${ value } leaves its ${ part } to a var()`
	);

/**
 * One side of a one-to-four-value box shorthand; a `var()` among fewer than
 * four values could stand for several, so it is ambiguous.
 *
 * @param {string} property The shorthand, named in a refusal.
 * @param {string} name     `top`, `right`, `bottom` or `left`.
 * @return {function( string ): string} The reader.
 */
const side = ( property, name ) => ( value ) => {
	const all = words( value );
	if ( all.length < 4 && all.some( isVar ) ) {
		throw ambiguous( property, value, name );
	}
	const [ top, right = top, bottom = top, left = right ] = all;
	return { top, right, bottom, left }[ name ];
};

/**
 * The start or end of a one-or-two-value logical shorthand; a lone `var()`
 * could stand for both, so it is ambiguous.
 *
 * @param {string}  property The shorthand, named in a refusal.
 * @param {boolean} last     Whether the end is asked.
 * @return {function( string ): string} The reader.
 */
const end = ( property, last ) => ( value ) => {
	const all = words( value );
	if ( all.length < 2 && all.some( isVar ) ) {
		throw ambiguous( property, value, last ? 'end' : 'start' );
	}
	const [ start, finish = start ] = all;
	return last ? finish : start;
};

const itself = ( value ) => value;

const LINE_STYLE =
	/^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset|auto)$/i;
const LINE_WIDTH =
	/^(thin|medium|thick|\d*\.?\d+[a-z%]*|(calc|min|max|clamp)\(.*\))$/i;
const LINE_INITIAL = {
	style: 'none',
	width: 'medium',
	color: 'currentcolor',
};

/**
 * One part of a border or outline shorthand. A literal answers for its part,
 * a colour being whatever is neither a width nor a style; a lone `var()`
 * answers for the one part the literals leave unnamed; anything else a
 * `var()` touches is ambiguous.
 *
 * @param {string} property The shorthand, named in a refusal.
 * @param {string} part     `color`, `width` or `style`.
 * @return {function( string ): string} The reader.
 */
const linePart = ( property, part ) => ( value ) => {
	const all = words( value );
	const kind = ( word ) => {
		if ( isVar( word ) ) {
			return 'var';
		}
		if ( LINE_STYLE.test( word ) ) {
			return 'style';
		}
		return LINE_WIDTH.test( word ) ? 'width' : 'color';
	};
	const kinds = all.map( kind );
	const literal = all.find( ( word, index ) => part === kinds[ index ] );
	if ( undefined !== literal ) {
		return literal;
	}
	const vars = all.filter( ( word, index ) => 'var' === kinds[ index ] );
	if ( ! vars.length ) {
		return LINE_INITIAL[ part ];
	}
	const unnamed = [ 'width', 'style', 'color' ].filter(
		( name ) => ! kinds.includes( name )
	);
	if ( 1 === vars.length && 1 === unnamed.length ) {
		return vars[ 0 ];
	}
	throw ambiguous( property, value, part );
};

// An image: a url, any gradient, an image() or image-set(), a cross-fade.
const IMAGE =
	/^(url|(-[a-z]+-)?(repeating-)?(linear|radial|conic)-gradient|-webkit-gradient|image|(-[a-z]+-)?image-set|(-[a-z]+-)?cross-fade|(-[a-z]+-)?element|paint)\(/i;
const MATH_FN = /^(calc|min|max|clamp)\(/i;
// A colour function, which background reads as its colour.
const COLOR_FN =
	/^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark|device-cmyk)\(/i;
const BACKGROUND_WORD =
	/^(none|repeat|no-repeat|repeat-x|repeat-y|space|round|scroll|fixed|local|center|top|bottom|left|right|border-box|padding-box|content-box|text|cover|contain|auto|-?\d*\.?\d+[a-z%]*)$/i;

/**
 * Whether a background word is a position, a size, a repeat, a box or an
 * attachment, a math function and a `/`-joined position and size included.
 *
 * @param {string} word The word.
 * @return {boolean} Whether it is one.
 */
const isBackgroundWord = ( word ) =>
	splitTopLevel( word, ( ch ) => '/' === ch ).every(
		( part ) => BACKGROUND_WORD.test( part ) || MATH_FN.test( part )
	);

/**
 * A background's layers, cut at its top-level commas, each as its words.
 *
 * @param {string} value The shorthand's value.
 * @return {string[][]} The layers.
 */
const layersOf = ( value ) =>
	splitTopLevel( value, ( ch ) => ',' === ch ).map( words );

/**
 * One layer's image: the image it names, `none`, or a refusal where a `var()`
 * could stand for one.
 *
 * @param {string[]} layer The layer's words.
 * @param {string}   value The shorthand's value, named in a refusal.
 * @return {string} The image.
 */
const layerImage = ( layer, value ) => {
	unmodelled( layer, value );
	const image = layer.find( ( word ) => IMAGE.test( word ) );
	if ( undefined !== image ) {
		return image;
	}
	if ( layer.some( isVar ) ) {
		throw ambiguous( 'background', value, 'image' );
	}
	return 'none';
};

/**
 * Refuse a background layer holding a function it does not model: neither an
 * image, a math function, a colour function nor a `var()`.
 *
 * @param {string[]} layer The layer's words.
 * @param {string}   value The shorthand's value, named in a refusal.
 * @throws {Error} Naming the value.
 */
const unmodelled = ( layer, value ) => {
	const unknown = layer
		.flatMap( ( word ) => splitTopLevel( word, ( ch ) => '/' === ch ) )
		.find(
			( word ) =>
				word.includes( '(' ) &&
				! [ IMAGE, MATH_FN, COLOR_FN ].some( ( fn ) =>
					fn.test( word )
				) &&
				! isVar( word )
		);
	if ( undefined !== unknown ) {
		throw new Error(
			`css-reader: background: ${ value } holds ${ unknown }, which it does not model`
		);
	}
};

const BACKGROUND = {
	'background-image': ( value ) =>
		layersOf( value )
			.map( ( layer ) => layerImage( layer, value ) )
			.join( ', ' ),
	'background-color': ( value ) => {
		const layer = layersOf( value ).pop() ?? [];
		unmodelled( layer, value );
		const literal = layer
			.filter(
				( word ) =>
					! isVar( word ) &&
					! IMAGE.test( word ) &&
					! isBackgroundWord( word )
			)
			.pop();
		if ( undefined !== literal ) {
			return literal;
		}
		if ( layer.some( isVar ) ) {
			throw ambiguous( 'background', value, 'color' );
		}
		return 'transparent';
	},
};

// The CSS-wide keywords that leave a custom property its parent's value.
const INHERITING = /^(inherit|unset|revert|revert-layer)$/i;
// A CSS-wide keyword sets every longhand of the shorthand to itself.
const CSS_WIDE = /^(inherit|initial|unset|revert|revert-layer)$/i;

/**
 * A reader that answers a CSS-wide keyword with itself, as a shorthand set to
 * one sets every longhand to it.
 *
 * @param {function( string, Object ): string} read The reader.
 * @return {function( string, Object ): string} The reader, keyword first.
 */
const keywordOr = ( read ) => ( value, options ) =>
	CSS_WIDE.test( value.trim() ) ? value.trim() : read( value, options );

const SYSTEM_FONT =
	/^(caption|icon|menu|message-box|small-caption|status-bar)$/i;
const SIZE_WORD =
	/^(0|\d*\.?\d+(px|rem|em|%|pt|pc|in|cm|mm|q|ch|ex|ic|cap|lh|rlh|vw|vh|vi|vb|vmin|vmax|[sld]v[hwib]|cq[whib]|cqmin|cqmax)|(calc|min|max|clamp)\(.*\)|(xx?x?-)?(small|large)|medium|smaller|larger)$/i;
// A numeric weight runs from 1 to 1000.
const NUMERIC_WEIGHT = '1000(\\.0+)?|[1-9]\\d{0,2}(\\.\\d+)?';
// An angle `oblique` may take.
const ANGLE = /^-?\d*\.?\d+(deg|grad|rad|turn)$/i;
const LEAD_WORD = new RegExp(
	`^(normal|italic|oblique|small-caps|bold|bolder|lighter|${ NUMERIC_WEIGHT }|(ultra-|extra-|semi-)?(condensed|expanded))$`,
	'i'
);

/**
 * A `font` value's tokens, a `/` outside parentheses standing alone.
 *
 * @param {string} value The shorthand's value.
 * @return {string[]} Its tokens.
 */
const fontTokens = ( value ) =>
	words( value ).flatMap( ( word ) =>
		cutTopLevel( word, ( ch ) => '/' === ch )
			.flatMap( ( piece, index ) =>
				index ? [ '/', piece ] : [ piece ]
			)
			.filter( Boolean )
	);

/**
 * A `font` shorthand's parts, read by position, past `keywordOr()`: the size is the word before a `/` or, without one, the
 * word before the family: the last word, and every word ahead of it back to a
 * size or a `var()`, or the last word alone when it is a `var()`. Each word
 * ahead of the size must be a style, variant, weight or stretch, or a `var()`.
 * A `var()` in the size's place stands for the size when a `/` or a literal
 * family fixes it, or when the caller's `isSizeVar` names it a size; the
 * reader carries no scale of its own.
 *
 * @param {string}                                    value   The shorthand's value.
 * @param {{isSizeVar?: function( string ): boolean}} options How the caller reads a `var()` in the size's place.
 * @return {{lead: string[], size: string, lineHeight: ?string, family: string[], slashed: boolean}} Its parts.
 * @throws {Error} When a `var()` leaves the size ambiguous, or a word is left unplaced.
 */
const fontParts = ( value, { isSizeVar = () => false } = {} ) => {
	const tokens = fontTokens( value );
	if ( 1 === tokens.length && SYSTEM_FONT.test( tokens[ 0 ] ) ) {
		throw new Error(
			`css-reader: font: ${ value } names a system font, which it does not model`
		);
	}
	const slash = tokens.indexOf( '/' );
	let at;
	let family;
	let lineHeight = null;
	if ( -1 !== slash ) {
		at = slash - 1;
		lineHeight = tokens[ slash + 1 ] ?? null;
		family = tokens.slice( slash + 2 );
	} else {
		let start = tokens.length - 1;
		while (
			start > 0 &&
			( tokens[ start - 1 ].endsWith( ',' ) ||
				( ! isVar( tokens[ tokens.length - 1 ] ) &&
					! SIZE_WORD.test( tokens[ start - 1 ] ) &&
					! isVar( tokens[ start - 1 ] ) ) )
		) {
			start -= 1;
		}
		at = start - 1;
		family = tokens.slice( start );
	}
	const size = tokens[ at ];
	const lead = tokens.slice( 0, Math.max( at, 0 ) );
	const unplaced = new Error(
		`css-reader: font: ${ value } leaves words it cannot place`
	);
	if ( undefined === size || ! family.length ) {
		throw tokens.some( isVar )
			? ambiguous( 'font', value, 'size' )
			: unplaced;
	}
	const placed = ( word, index ) =>
		isVar( word ) ||
		LEAD_WORD.test( word ) ||
		( ANGLE.test( word ) && /^oblique$/i.test( lead[ index - 1 ] ?? '' ) );
	if ( ! lead.every( placed ) ) {
		throw unplaced;
	}
	const parts = { lead, size, lineHeight, family, slashed: -1 !== slash };
	if ( SIZE_WORD.test( size ) ) {
		return parts;
	}
	if ( ! isVar( size ) ) {
		throw unplaced;
	}
	if ( parts.slashed || ! isVar( family[ 0 ] ) || isSizeVar( size ) ) {
		return parts;
	}
	throw ambiguous( 'font', value, 'size' );
};

/**
 * The size a `font` shorthand sets, read by position; a CSS-wide keyword
 * answers itself.
 *
 * @param {string}                                    value   The shorthand's value.
 * @param {{isSizeVar?: function( string ): boolean}} options How the caller reads a `var()` in the size's place.
 * @return {string} The size as written.
 * @throws {Error} When a `var()` leaves the size ambiguous, or a word is left unplaced.
 */
const shorthandSize = keywordOr(
	( value, options ) => fontParts( value, options ).size
);

/**
 * A reader of one `font` part, handing its caller's options to `fontParts()`.
 *
 * @param {function( Object, string ): string} read Given the parts and the value.
 * @return {function( string, Object ): string} The reader.
 */
const fontPart = ( read ) => ( value, options ) =>
	read( fontParts( value, options ), value );

/**
 * Whether a `var()` could stand for a word ahead of the size: one ahead of it,
 * or one in the size's place, which may expand to lead words and a size.
 *
 * @param {Object}   parts      The shorthand's parts.
 * @param {string[]} parts.lead The words ahead of the size.
 * @param {string}   parts.size The size.
 * @return {boolean} Whether one could.
 */
const leadInVar = ( { lead, size } ) => lead.some( isVar ) || isVar( size );

/**
 * A word ahead of a `font` shorthand's size, by its pattern.
 *
 * @param {RegExp} pattern  The part's words.
 * @param {string} part     The part, named in a refusal.
 * @param {string} fallback The part's initial value.
 * @return {function( string ): string} The reader.
 */
const fontLead = ( pattern, part, fallback ) =>
	fontPart( ( parts, value ) => {
		const found = parts.lead.find( ( word ) => pattern.test( word ) );
		if ( undefined !== found ) {
			return found;
		}
		if ( leadInVar( parts ) ) {
			throw ambiguous( 'font', value, part );
		}
		return fallback;
	} );

const FONT = {
	'font-size': fontPart( ( { size } ) => size ),
	'font-family': fontPart( ( { family } ) => family.join( ' ' ) ),
	'font-weight': fontLead(
		new RegExp( `^(bold|bolder|lighter|${ NUMERIC_WEIGHT })$`, 'i' ),
		'weight',
		'normal'
	),
	'font-style': fontPart( ( parts, value ) => {
		const { lead } = parts;
		const style = lead.find( ( word ) =>
			/^(italic|oblique)$/i.test( word )
		);
		const at = lead.indexOf( style );
		const next = lead[ at + 1 ];
		const oblique = /^oblique$/i.test( style ?? '' );
		if ( oblique && undefined !== next && ANGLE.test( next ) ) {
			return `${ style } ${ next }`;
		}
		const angleInVar =
			oblique &&
			( undefined === next ? isVar( parts.size ) : isVar( next ) );
		if ( angleInVar || ( undefined === style && leadInVar( parts ) ) ) {
			throw ambiguous( 'font', value, 'style' );
		}
		return style ?? 'normal';
	} ),
	'line-height': fontPart( ( parts, value ) => {
		if ( parts.slashed ) {
			return parts.lineHeight;
		}
		if ( isVar( parts.size ) || isVar( parts.family[ 0 ] ) ) {
			throw ambiguous( 'font', value, 'line-height' );
		}
		return 'normal';
	} ),
};

// Each physical side as its logical axis and edge on a horizontal LTR page.
const SIDES = {
	top: [ 'block', 'start' ],
	bottom: [ 'block', 'end' ],
	left: [ 'inline', 'start' ],
	right: [ 'inline', 'end' ],
};

/**
 * Every property that sets a modelled longhand, and how to read the longhand
 * from each.
 *
 * @return {Object<string, Object<string, function( string ): string>>} Longhand to readers.
 */
const competitors = () => {
	const table = {
		'inline-size': { width: itself, 'inline-size': itself },
		'block-size': { height: itself, 'block-size': itself },
		'min-inline-size': { 'min-width': itself, 'min-inline-size': itself },
		'max-inline-size': { 'max-width': itself, 'max-inline-size': itself },
		'min-block-size': { 'min-height': itself, 'min-block-size': itself },
		'max-block-size': { 'max-height': itself, 'max-block-size': itself },
		appearance: { appearance: itself },
	};
	for ( const [ name, read ] of Object.entries( BACKGROUND ) ) {
		table[ name ] = { background: read, [ name ]: itself };
	}
	for ( const [ name, read ] of Object.entries( FONT ) ) {
		table[ name ] = { font: read, [ name ]: itself };
	}
	for ( const part of [ 'color', 'width', 'style' ] ) {
		table[ `outline-${ part }` ] = {
			outline: linePart( 'outline', part ),
			[ `outline-${ part }` ]: itself,
		};
	}
	for ( const [ physical, [ axis, edge ] ] of Object.entries( SIDES ) ) {
		const last = 'end' === edge;
		for ( const box of [ 'padding', 'margin' ] ) {
			table[ `${ box }-${ physical }` ] = {
				[ box ]: side( box, physical ),
				[ `${ box }-${ axis }` ]: end( `${ box }-${ axis }`, last ),
				[ `${ box }-${ axis }-${ edge }` ]: itself,
				[ `${ box }-${ physical }` ]: itself,
			};
		}
		table[ physical ] = {
			inset: side( 'inset', physical ),
			[ `inset-${ axis }` ]: end( `inset-${ axis }`, last ),
			[ `inset-${ axis }-${ edge }` ]: itself,
			[ physical ]: itself,
		};
		for ( const part of [ 'color', 'width', 'style' ] ) {
			const line = ( property ) => linePart( property, part );
			table[ `border-${ physical }-${ part }` ] = {
				border: line( 'border' ),
				[ `border-${ physical }` ]: line( `border-${ physical }` ),
				[ `border-${ axis }` ]: line( `border-${ axis }` ),
				[ `border-${ axis }-${ edge }` ]: line(
					`border-${ axis }-${ edge }`
				),
				[ `border-${ part }` ]: side( `border-${ part }`, physical ),
				[ `border-${ axis }-${ part }` ]: end(
					`border-${ axis }-${ part }`,
					last
				),
				[ `border-${ axis }-${ edge }-${ part }` ]: itself,
				[ `border-${ physical }-${ part }` ]: itself,
			};
		}
	}
	return table;
};
const COMPETITORS = competitors();

// Each alias of a modelled longhand, and the longhand it names.
const ALIASES = {};
// Each shorthand the model covers, and the longhands it sets.
const COVERS = {};
for ( const [ longhand, readers ] of Object.entries( COMPETITORS ) ) {
	for ( const [ property, read ] of Object.entries( readers ) ) {
		if ( property === longhand ) {
			continue;
		}
		if ( itself === read ) {
			ALIASES[ property ] = longhand;
		} else {
			( COVERS[ property ] ??= [] ).push( longhand );
		}
	}
}
for ( const [ physical, [ axis, edge ] ] of Object.entries( SIDES ) ) {
	for ( const box of [ 'scroll-margin', 'scroll-padding' ] ) {
		ALIASES[ `${ box }-${ axis }-${ edge }` ] = `${ box }-${ physical }`;
	}
}
for ( const block of [ 'top', 'bottom' ] ) {
	for ( const inline of [ 'left', 'right' ] ) {
		const logical = `${ SIDES[ block ][ 1 ] }-${ SIDES[ inline ][ 1 ] }`;
		ALIASES[
			`border-${ logical }-radius`
		] = `border-${ block }-${ inline }-radius`;
	}
}

const FONT_RESETS = [
	'font-variant-caps',
	'font-variant-numeric',
	'font-variant-ligatures',
	'font-variant-east-asian',
	'font-variant-position',
	'font-variant-alternates',
	'font-variant-emoji',
	'font-stretch',
	'font-size-adjust',
	'font-kerning',
	'font-optical-sizing',
	'font-variation-settings',
	'font-feature-settings',
	'font-language-override',
];
const BORDER_IMAGE = [
	'border-image-source',
	'border-image-slice',
	'border-image-width',
	'border-image-outset',
	'border-image-repeat',
];

const MASK = [
	'mask-image',
	'mask-mode',
	'mask-repeat',
	'mask-position',
	'mask-clip',
	'mask-origin',
	'mask-size',
	'mask-composite',
];

const MASK_BORDER = [
	'mask-border-source',
	'mask-border-slice',
	'mask-border-width',
	'mask-border-outset',
	'mask-border-repeat',
	'mask-border-mode',
];

/**
 * A box shorthand and its two axis shorthands, each with the physical
 * longhands it sets.
 *
 * @param {string} property The box shorthand.
 * @return {Object<string, string[]>} Shorthand to longhands.
 */
const BOX_SETS = ( property ) => {
	const sides = ( axis ) =>
		Object.keys( SIDES )
			.filter( ( name ) => ! axis || axis === SIDES[ name ][ 0 ] )
			.map( ( name ) => `${ property }-${ name }` );
	return {
		[ property ]: sides(),
		[ `${ property }-block` ]: sides( 'block' ),
		[ `${ property }-inline` ]: sides( 'inline' ),
	};
};

// Shorthands outside the model, and the longhands each sets.
const SETS = {
	flex: [ 'flex-grow', 'flex-shrink', 'flex-basis' ],
	'flex-flow': [ 'flex-direction', 'flex-wrap' ],
	gap: [ 'row-gap', 'column-gap' ],
	overflow: [ 'overflow-x', 'overflow-y' ],
	'list-style': [
		'list-style-type',
		'list-style-position',
		'list-style-image',
	],
	'text-decoration': [
		'text-decoration-line',
		'text-decoration-style',
		'text-decoration-color',
		'text-decoration-thickness',
	],
	'border-radius': [
		'border-top-left-radius',
		'border-top-right-radius',
		'border-bottom-right-radius',
		'border-bottom-left-radius',
	],
	transition: [
		'transition-property',
		'transition-duration',
		'transition-timing-function',
		'transition-delay',
		'transition-behavior',
	],
	animation: [
		'animation-name',
		'animation-duration',
		'animation-timing-function',
		'animation-delay',
		'animation-iteration-count',
		'animation-direction',
		'animation-fill-mode',
		'animation-play-state',
		'animation-timeline',
		'animation-composition',
		'animation-range-start',
		'animation-range-end',
	],
	'animation-range': [ 'animation-range-start', 'animation-range-end' ],
	'place-items': [ 'align-items', 'justify-items' ],
	'place-content': [ 'align-content', 'justify-content' ],
	'place-self': [ 'align-self', 'justify-self' ],
	'grid-area': [
		'grid-row-start',
		'grid-column-start',
		'grid-row-end',
		'grid-column-end',
	],
	'grid-row': [ 'grid-row-start', 'grid-row-end' ],
	'grid-column': [ 'grid-column-start', 'grid-column-end' ],
	'grid-template': [
		'grid-template-rows',
		'grid-template-columns',
		'grid-template-areas',
	],
	columns: [ 'column-width', 'column-count' ],
	'column-rule': [
		'column-rule-width',
		'column-rule-style',
		'column-rule-color',
	],
	background: [
		'background-position',
		'background-position-x',
		'background-position-y',
		'background-size',
		'background-repeat',
		'background-attachment',
		'background-origin',
		'background-clip',
	],
	'background-position': [ 'background-position-x', 'background-position-y' ],
	font: [ 'font-variant', ...FONT_RESETS ],
	'font-variant': FONT_RESETS.filter( ( longhand ) =>
		longhand.startsWith( 'font-variant-' )
	),
	border: BORDER_IMAGE,
	'border-image': BORDER_IMAGE,
	'-webkit-text-stroke': [
		'-webkit-text-stroke-width',
		'-webkit-text-stroke-color',
	],
	'mask-border': MASK_BORDER,
	grid: [
		'grid-template-rows',
		'grid-template-columns',
		'grid-template-areas',
		'grid-auto-rows',
		'grid-auto-columns',
		'grid-auto-flow',
	],
	'grid-gap': [ 'row-gap', 'column-gap' ],
	'grid-row-gap': [ 'row-gap' ],
	'grid-column-gap': [ 'column-gap' ],
	mask: [ ...MASK, ...MASK_BORDER ],
	offset: [
		'offset-position',
		'offset-path',
		'offset-distance',
		'offset-rotate',
		'offset-anchor',
	],
	...BOX_SETS( 'scroll-margin' ),
	...BOX_SETS( 'scroll-padding' ),
	'overscroll-behavior': [ 'overscroll-behavior-x', 'overscroll-behavior-y' ],
	'text-emphasis': [ 'text-emphasis-style', 'text-emphasis-color' ],
	'font-synthesis': [
		'font-synthesis-weight',
		'font-synthesis-style',
		'font-synthesis-small-caps',
		'font-synthesis-position',
	],
	container: [ 'container-name', 'container-type' ],
	'contain-intrinsic-size': [
		'contain-intrinsic-width',
		'contain-intrinsic-height',
	],
	'white-space': [ 'white-space-collapse', 'text-wrap-mode' ],
	'text-wrap': [ 'text-wrap-mode', 'text-wrap-style' ],
	'word-wrap': [ 'overflow-wrap' ],
};

// Every property the tables name, which keeps a vendor prefix it carries.
const NAMED = new Set( [
	...Object.keys( COMPETITORS ),
	...Object.values( COMPETITORS ).flatMap( Object.keys ),
	...Object.keys( SETS ),
	...Object.values( SETS ).flat(),
] );

/**
 * The longhand or shorthand a property names: an alias's longhand, and a
 * vendor-prefixed property's unprefixed twin unless the tables name it.
 *
 * @param {string} property The property, as written.
 * @return {string} What it names.
 */
const canonical = ( property ) => {
	const bare = NAMED.has( property )
		? property
		: property.replace( /^-(webkit|moz|ms|o)-/, '' );
	return ALIASES[ bare ] ?? bare;
};

const HOVERED = 'data-css-reader-hovered';

/**
 * Whether an element matches a selector, `:hover` reading the hovered mark
 * when a caller names a hovered element, and jsdom's own pointer otherwise.
 *
 * @param {Element} element  The element.
 * @param {string}  selector One complex selector.
 * @param {boolean} marked   Whether a hovered element is marked.
 * @return {boolean} Whether it matches.
 * @throws {Error} Naming a selector the DOM cannot read.
 */
const matches = ( element, selector, marked ) => {
	try {
		return element.matches(
			marked
				? selector.replace( /:hover(?![\w-])/g, `[${ HOVERED }]` )
				: selector
		);
	} catch ( error ) {
		throw new Error(
			`css-reader cannot match ${ selector }: ${ error.message }`
		);
	}
};

const RULES = new WeakMap();

/**
 * A sheet's top-level rules, each with its selectors, their weights and its
 * declarations, read once per sheet. A sheet is read as immutable: one whose
 * top-level nodes, a rule's selector or a rule's children are not the ones it
 * read, each compared by identity, throws, so a stale reading never answers.
 * A sheet holding a rule nested in a rule throws on first reading: it reads
 * the flat sheets Sass compiles, and resolves no `&`.
 *
 * @param {import('postcss').Root} sheet The sheet.
 * @return {Array<{selectors: Array<{text: string, weight: Object}>, decls: import('postcss').Declaration[]}>} Its rules.
 * @throws {Error} When the sheet changed after it was read.
 */
const rulesOf = ( sheet ) => {
	const read = RULES.get( sheet );
	if ( read ) {
		const changed =
			read.nodes.length !== sheet.nodes.length ||
			read.nodes.some( ( node, at ) => node !== sheet.nodes[ at ] ) ||
			read.rules.some(
				( { rule, selector, nodes } ) =>
					rule.selector !== selector ||
					nodes.length !== rule.nodes.length ||
					nodes.some( ( node, at ) => node !== rule.nodes[ at ] )
			);
		if ( changed ) {
			throw new Error(
				'css-reader: a sheet changed after it was read; parse it again'
			);
		}
		return read.rules;
	}
	sheet.walkRules( ( rule ) => {
		if ( 'rule' === rule.parent.type ) {
			throw new Error(
				`css-reader: ${ rule.selector } nests inside ${ rule.parent.selector }; compile the sheet flat`
			);
		}
	} );
	const rules = [];
	sheet.each( ( rule ) => {
		if ( 'rule' !== rule.type ) {
			return;
		}
		rules.push( {
			rule,
			selector: rule.selector,
			nodes: [ ...rule.nodes ],
			selectors: splitTopLevel( rule.selector, ( ch ) => ',' === ch )
				.filter( ( text ) => ! text.includes( '::' ) )
				.map( ( text ) => ( { text, weight: specificity( text ) } ) ),
			decls: rule.nodes.filter( ( node ) => 'decl' === node.type ),
		} );
	} );
	RULES.set( sheet, { nodes: [ ...sheet.nodes ], rules } );
	return rules;
};

// The match lists one resolved() or computed() call reuses, else null.
let scope = null;

/**
 * Each declaration that reaches the element, in source order, with the
 * heaviest of its rule's selectors that matches, the hovered element and its
 * ancestors marked for `:hover` while the rules are matched.
 *
 * @param {Element}                  element The element.
 * @param {import('postcss').Root[]} sheets  The sheets, in cascade order.
 * @param {{hovered?: Element}}      options What the pointer rests on.
 * @return {Array<{decl: import('postcss').Declaration, selector: string, weight: Object}>} The matches.
 */
const matchesOf = ( element, sheets, options ) => {
	if ( scope?.has( element ) ) {
		return scope.get( element );
	}
	const marked = [];
	for ( let n = options.hovered; n; n = n.parentElement ) {
		if ( ! n.hasAttribute( HOVERED ) ) {
			n.setAttribute( HOVERED, '' );
			marked.push( n );
		}
	}
	const found = [];
	try {
		for ( const sheet of sheets ) {
			for ( const { selectors, decls } of rulesOf( sheet ) ) {
				let best = null;
				for ( const candidate of selectors ) {
					if (
						( ! best ||
							compare( candidate.weight, best.weight ) > 0 ) &&
						matches(
							element,
							candidate.text,
							Boolean( options.hovered )
						)
					) {
						best = candidate;
					}
				}
				if ( best ) {
					for ( const decl of decls ) {
						found.push( {
							decl,
							selector: best.text,
							weight: best.weight,
						} );
					}
				}
			}
		}
	} finally {
		marked.forEach( ( n ) => n.removeAttribute( HOVERED ) );
	}
	scope?.set( element, found );
	return found;
};

/**
 * Run `body` with one match list per element, for a call that asks the same
 * elements many times while the DOM holds still.
 *
 * @param {function(): *} body The call.
 * @return {*} What it answers.
 */
const scoped = ( body ) => {
	if ( scope ) {
		return body();
	}
	scope = new Map();
	try {
		return body();
	} finally {
		scope = null;
	}
};

/**
 * A refusal naming a covered shorthand and its longhands.
 *
 * @param {string} property The shorthand or alias.
 * @return {Error} The refusal.
 */
const askALonghand = ( property ) =>
	new Error(
		`css-reader: ${ property } is a shorthand; ask a longhand (${ COVERS[
			property
		].join( ', ' ) })`
	);

/**
 * The value a longhand wins on an element, as written.
 *
 * @param {Element}                                                      element  The element.
 * @param {string}                                                       longhand The property.
 * @param {import('postcss').Root[]}                                     sheets   The sheets, in cascade order.
 * @param {{hovered?: Element, isSizeVar?: function( string ): boolean}} options  What the pointer rests on, and how a `font` reads a `var()` in the size's place, as `shorthandSize()` does.
 * @return {string|undefined} The value, or undefined when every rule leaves it unset.
 * @throws {Error} When asked for a covered shorthand, or a value it cannot model.
 */
const winning = ( element, longhand, sheets, options = {} ) => {
	const best = winner( element, longhand, sheets, options );
	return best?.read( best.decl.value, options );
};

/**
 * The longhands a property sets: a modelled longhand or its alias, a covered
 * shorthand's, an outside shorthand's, or the property alone.
 *
 * @param {string} property The property.
 * @return {string[]} Its longhands.
 */
const longhandsOf = ( property ) => {
	const own = canonical( property );
	const sets = [ ...( COVERS[ own ] ?? [] ), ...( SETS[ own ] ?? [] ) ];
	return sets.length ? sets : [ own ];
};

// What `all` leaves alone: custom properties, direction and unicode-bidi.
const BEYOND_ALL = /^(--|direction$|unicode-bidi$)/;

/**
 * The reader an `all` declaration competes with for a longhand: every one but
 * custom properties, `direction` and `unicode-bidi`, read as the CSS-wide
 * keyword `all` takes, the only values it may.
 *
 * @param {import('postcss').Declaration} decl     The declaration.
 * @param {string}                        longhand The longhand asked for.
 * @return {(function( string ): string)|undefined} The reader, or none.
 */
const allOf = ( decl, longhand ) => {
	if ( 'all' !== decl.prop || BEYOND_ALL.test( longhand ) ) {
		return undefined;
	}
	return ( value ) => {
		throw new Error(
			`css-reader: all: ${ value } is not a CSS-wide keyword`
		);
	};
};

/**
 * The declaration a longhand wins on an element, with its reader. An alias
 * answers for the longhand it names.
 *
 * @param {Element}                  element The element.
 * @param {string}                   asked   The property, or an alias of it.
 * @param {import('postcss').Root[]} sheets  The sheets, in cascade order.
 * @param {{hovered?: Element}}      options What the pointer rests on.
 * @return {?{decl: import('postcss').Declaration, read: function( string ): string}} The winner, or null.
 * @throws {Error} When asked for a covered shorthand, or a pair it cannot model.
 */
const winner = ( element, asked, sheets, options ) => {
	const longhand = canonical( asked );
	if ( COVERS[ longhand ] ) {
		throw askALonghand( longhand );
	}
	const readers = COMPETITORS[ longhand ] ?? { [ longhand ]: itself };
	let best = null;
	for ( const { decl, selector, weight } of matchesOf(
		element,
		sheets,
		options
	) ) {
		const read =
			readers[ decl.prop ] ??
			readers[ canonical( decl.prop ) ] ??
			allOf( decl, longhand );
		if ( ! read ) {
			const sets = longhandsOf( decl.prop );
			if (
				longhandsOf( longhand ).some( ( one ) => sets.includes( one ) )
			) {
				throw new Error(
					`css-reader: ${ decl.prop } and ${ longhand } overlap, which it does not model (${ selector })`
				);
			}
			continue;
		}
		const important = Boolean( decl.important );
		if (
			! best ||
			important > best.important ||
			( important === best.important &&
				compare( weight, best.weight ) >= 0 )
		) {
			best = { decl, read: keywordOr( read ), weight, important };
		}
	}
	return best;
};

/**
 * A longhand's winning value with every custom property its declaration
 * reads resolved before the longhand is read from it, so a shorthand a token
 * fills is read as the browser reads it. A custom property resolves where the
 * cascade sets it, through the element and its ancestors, as custom
 * properties inherit, and afresh on the ancestor that sets it. A custom
 * property set to `inherit`, `unset` or `revert` takes its parent's value, and
 * one set to `initial`, the guaranteed-invalid value, takes the fallback, as
 * one every ancestor leaves unset does; one with neither makes the value
 * `GUARANTEED_INVALID`, which it answers before reading any longhand.
 *
 * @param {Element}                  element  The element.
 * @param {string}                   longhand The property.
 * @param {import('postcss').Root[]} sheets   The sheets, in cascade order.
 * @param {Object}                   options  As for `winning()`.
 * @return {string|symbol|undefined} The value, resolved, or `GUARANTEED_INVALID`.
 * @throws {Error} Naming a custom property that reaches itself.
 */
const computed = ( element, longhand, sheets, options = {} ) =>
	scoped( () => {
		const lookupAt = ( node ) => ( name ) => {
			for ( let n = node; n; n = n.parentElement ) {
				const set = winning( n, name, sheets, options )?.trim();
				if ( undefined === set || INHERITING.test( set ) ) {
					continue;
				}
				return /^initial$/i.test( set )
					? undefined
					: { value: set, lookup: lookupAt( n ), fresh: n !== node };
			}
			return undefined;
		};
		const best = winner( element, longhand, sheets, options );
		if ( ! best ) {
			return undefined;
		}
		const value = resolveWith( best.decl.value, lookupAt( element ) );
		return GUARANTEED_INVALID === value
			? value
			: best.read( value, options );
	} );

/**
 * Every longhand a rule matching the element sets, through a shorthand or an
 * alias the model covers, an outside shorthand's own longhands, or by name,
 * each read when called, so it refuses what `winning()` refuses. The record
 * enumerates the values it read; reading a key whose value the reader refuses
 * throws that refusal, an alias reads the longhand it names, and reading a
 * covered shorthand throws, naming the longhands to read.
 *
 * @param {Element}                  element The element.
 * @param {import('postcss').Root[]} sheets  The sheets, in cascade order.
 * @param {{hovered?: Element}}      options What the pointer rests on.
 * @return {Object<string, string>} Longhand to winning value.
 */
const resolved = ( element, sheets, options = {} ) =>
	scoped( () => {
		const record = {};
		const refusals = {};
		for ( const { decl } of matchesOf( element, sheets, options ) ) {
			const own = COVERS[ canonical( decl.prop ) ]
				? []
				: [ canonical( decl.prop ) ];
			for ( const longhand of new Set( [
				...own,
				...longhandsOf( decl.prop ),
			] ) ) {
				if (
					Object.hasOwn( record, longhand ) ||
					Object.hasOwn( refusals, longhand )
				) {
					continue;
				}
				try {
					record[ longhand ] = winning(
						element,
						longhand,
						sheets,
						options
					);
				} catch ( error ) {
					refusals[ longhand ] = error;
				}
			}
		}
		return new Proxy( record, {
			get( target, key ) {
				if ( 'string' !== typeof key ) {
					return target[ key ];
				}
				const longhand = canonical( key );
				if ( COVERS[ longhand ] ) {
					throw askALonghand( longhand );
				}
				if ( refusals[ longhand ] ) {
					throw refusals[ longhand ];
				}
				return target[ longhand ];
			},
		} );
	} );

module.exports = {
	GUARANTEED_INVALID,
	closeOf,
	splitTopLevel,
	words,
	resolveVars,
	shorthandSize,
	specificity,
	compareSpecificity: compare,
	winning,
	computed,
	resolved,
};
