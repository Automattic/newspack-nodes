/**
 * css-reader tests — the one reading of compiled CSS every plugin's style
 * tests share: a value's words, a var() resolved, a selector's weight, and
 * the value a longhand wins on an element, every shorthand and alias that
 * sets it competing.
 */

const postcss = require( 'postcss' );
const {
	words,
	resolveVars,
	shorthandSize,
	specificity,
	winning,
	computed,
	resolved,
	GUARANTEED_INVALID,
	closeOf,
} = require( '../css-reader.cjs' );

describe( 'words', () => {
	it( 'splits on whitespace outside parentheses alone', () => {
		expect(
			words( ' 700 var(--np-text-2xs, 12px) / 1.5 var(--font-mono) ' )
		).toEqual( [
			'700',
			'var(--np-text-2xs, 12px)',
			'/',
			'1.5',
			'var(--font-mono)',
		] );
	} );
} );

describe( 'resolveVars', () => {
	it( 'resolves each var() to its token, else to its fallback', () => {
		expect(
			resolveVars(
				'0 0 0 1px var(--focus-halo, var(--paper, var(--np-surface)))',
				{ '--paper': '#fbf8f1' }
			)
		).toBe( '0 0 0 1px #fbf8f1' );
		expect(
			resolveVars( 'var(--kea, rgb(1, 2, 3)) var(--moa)', {
				'--moa': 'solid',
			} )
		).toBe( 'rgb(1, 2, 3) solid' );
	} );
} );

describe( 'resolveVars, byte for byte', () => {
	it( 'keeps a string, an empty fallback and a comma fallback as written', () => {
		expect( resolveVars( 'content: "var(" var(--a, x)', {} ) ).toBe(
			'content: "var(" x'
		);
		expect( resolveVars( 'a var(--none,) b', {} ) ).toBe( 'a  b' );
		expect( resolveVars( 'var(--f,Arial,sans-serif)', {} ) ).toBe(
			'Arial,sans-serif'
		);
	} );

	it.each( [ 'var()', 'var( )', 'var(,x)', 'var(kea, x)' ] )(
		'refuses %s, which names no custom property',
		( value ) => {
			expect( () => resolveVars( `a ${ value } b`, {} ) ).toThrow(
				`css-reader: a ${ value } b holds a var() naming no custom property`
			);
		}
	);

	it( 'leaves a name merely ending in var alone, and invalidates an unset var', () => {
		expect( resolveVars( 'myvar(--a) var(--b)', { '--b': 'x' } ) ).toBe(
			'myvar(--a) x'
		);
		expect( resolveVars( 'a var(--none) b', {} ) ).toBe(
			GUARANTEED_INVALID
		);
	} );

	it( 'keeps a property holding the words guaranteed-invalid apart from one', () => {
		expect(
			resolveVars( 'var(--c, 4px)', { '--c': 'guaranteed-invalid' } )
		).toBe( 'guaranteed-invalid' );
		expect( resolveVars( 'var(--u)', {} ) ).toBe( GUARANTEED_INVALID );
	} );

	it( 'names the function an unclosed parenthesis opens', () => {
		expect( () => closeOf( 'a min(2px', 6 ) ).toThrow( 'unclosed min()' );
		expect( () => resolveVars( 'a var(--b', {} ) ).toThrow(
			'unclosed var()'
		);
	} );

	it( 'refuses a cycle, naming it', () => {
		expect( () =>
			resolveVars( 'var(--a)', { '--a': 'var(--b)', '--b': 'var(--a)' } )
		).toThrow( '--a reads itself through --a > --b > --a' );
	} );
} );

describe( 'shorthandSize', () => {
	it.each( [
		[ '700 9px var(--font-mono)', '9px' ],
		[ 'italic 600 0.7rem/1.4 "Fira Code"', '0.7rem' ],
		[ '400 var(--np-text-2xs) / 1.5 var(--f)', 'var(--np-text-2xs)' ],
		[ 'inherit', 'inherit' ],
	] )( 'reads the size of font: %s', ( value, size ) => {
		expect( shorthandSize( value ) ).toBe( size );
	} );

	// The caller names which var() is a size; the reader carries no scale.
	it( 'takes a var() in the size place as the size where its caller says so', () => {
		const value = '700 var(--kea-size) var(--font-mono)';
		expect( () => shorthandSize( value ) ).toThrow( 'to a var()' );
		expect(
			shorthandSize( value, {
				isSizeVar: ( word ) => word.startsWith( 'var(--kea-' ),
			} )
		).toBe( 'var(--kea-size)' );
	} );
} );

describe( 'specificity', () => {
	it.each( [
		[ '.a .b', [ 0, 2, 0 ] ],
		[ 'select:not([multiple], [size^="2"])', [ 0, 1, 1 ] ],
		[ '.a:is(.b, #c)', [ 1, 1, 0 ] ],
		[ '.a:where(.b, #c) td', [ 0, 1, 1 ] ],
		[ ':where(.a:not(.b)) p', [ 0, 0, 1 ] ],
		[ '.f:has(.i[aria-invalid="true"]) .b', [ 0, 4, 0 ] ],
		[ 'a:hover:focus-within', [ 0, 2, 1 ] ],
	] )( 'weighs %s', ( selector, [ a, b, c ] ) => {
		expect( specificity( selector ) ).toEqual( { a, b, c } );
	} );
} );

describe( 'winning', () => {
	const probe = () => {
		document.body.innerHTML =
			'<div class="root"><p id="probe" class="cell"></p></div>';
		return document.getElementById( 'probe' );
	};
	const sheet = ( css ) => postcss.parse( css );

	it( 'takes a longhand from the heaviest shorthand that sets it', () => {
		const sheets = [
			sheet( '.cell { padding-right: 22px; border-top-color: teal; }' ),
			sheet(
				'.root .cell { padding: 4px 9px; border: 2px dashed var(--rose, red); }'
			),
		];
		expect( winning( probe(), 'padding-right', sheets ) ).toBe( '9px' );
		expect( winning( probe(), 'border-top-color', sheets ) ).toBe(
			'var(--rose, red)'
		);
	} );

	it( 'reads a font size and an inline size through their shorthand and alias', () => {
		const sheets = [
			sheet( '.root .cell { font: 700 10px/1.2 mono; width: 31px; }' ),
		];
		expect( winning( probe(), 'font-size', sheets ) ).toBe( '10px' );
		expect( winning( probe(), 'inline-size', sheets ) ).toBe( '31px' );
	} );

	it( 'breaks a tie by source order across sheets', () => {
		const sheets = [
			sheet( '.cell { color: teal; }' ),
			sheet( '.cell { color: plum; }' ),
		];
		expect( winning( probe(), 'color', sheets ) ).toBe( 'plum' );
	} );

	it( 'leaves out a rule inside an at-rule and a pseudo-element', () => {
		const sheets = [
			sheet(
				'@media (min-width: 1px) { .root .cell { color: plum; } }' +
					'.cell::before { color: navy; } .cell { color: teal; }'
			),
		];
		expect( winning( probe(), 'color', sheets ) ).toBe( 'teal' );
	} );

	it.each( [
		[ 'margin-left', '.root .cell { margin: 1px 2px 3px 4px; }', '4px' ],
		[ 'margin-top', '.root .cell { margin-block: 5px 6px; }', '5px' ],
		[ 'padding-left', '.root .cell { padding-inline: 7px 8px; }', '7px' ],
		[
			'border-left-width',
			'.root .cell { border-inline-start: 3px solid teal; }',
			'3px',
		],
		[
			'border-bottom-style',
			'.root .cell { border: 1px dashed red; }',
			'dashed',
		],
		[
			'border-right-color',
			'.root .cell { border-color: red blue; }',
			'blue',
		],
		[
			'background-color',
			'.root .cell { background: url(k.svg) no-repeat center / 8px #f5f0e6; }',
			'#f5f0e6',
		],
		[
			'background-color',
			'.root .cell { background: none; }',
			'transparent',
		],
		[
			'font-family',
			'.root .cell { font: italic 700 10px/1.2 "Fira Code", mono; }',
			'"Fira Code", mono',
		],
		[
			'font-weight',
			'.root .cell { font: italic 700 10px/1.2 mono; }',
			'700',
		],
		[ 'font-style', '.root .cell { font: 10px mono; }', 'normal' ],
		[ 'line-height', '.root .cell { font: 10px/1.2 mono; }', '1.2' ],
	] )( 'reads %s from %s', ( longhand, css, value ) => {
		expect( winning( probe(), longhand, [ sheet( css ) ] ) ).toBe( value );
	} );

	it( 'refuses a longhand a shorthand it does not model sets on the element', () => {
		expect( () =>
			winning( probe(), 'flex-grow', [
				sheet( '.cell { flex: 1 1 22em; }' ),
			] )
		).toThrow( 'flex and flex-grow overlap' );
		expect( () =>
			winning( probe(), 'flex', [ sheet( '.cell { flex-grow: 2; }' ) ] )
		).toThrow( 'flex-grow and flex overlap' );
		expect(
			winning( probe(), 'flex-grow', [
				sheet( '.elsewhere { flex: 1 1 22em; }' ),
			] )
		).toBeUndefined();
	} );

	it.each( [
		'padding',
		'margin-block',
		'border',
		'border-color',
		'border-width',
		'background',
		'outline',
		'font',
		'inset',
	] )( 'refuses to answer the shorthand %s', ( property ) => {
		expect( () =>
			winning( probe(), property, [ sheet( '.cell { color: teal; }' ) ] )
		).toThrow( `${ property } is a shorthand; ask a longhand` );
	} );

	it.each( [
		[ 'width', '.cell { inline-size: 31px; }', '31px' ],
		[ 'inline-size', '.cell { width: 32px; }', '32px' ],
		[ 'height', '.cell { block-size: 9px; }', '9px' ],
		[ 'min-width', '.cell { min-inline-size: 4px; }', '4px' ],
		[ '-webkit-appearance', '.cell { appearance: none; }', 'none' ],
		[
			'padding-inline-start',
			'.cell { padding: 1px 2px 3px 4px; }',
			'4px',
		],
		[ 'top', '.cell { inset: 1px 2px; }', '1px' ],
		[ 'right', '.cell { inset: 1px 2px; }', '2px' ],
		[ 'inset-block-start', '.cell { top: 5px; }', '5px' ],
		[ 'left', '.cell { inset-inline: 6px 7px; }', '6px' ],
	] )(
		'answers %s through its alias or shorthand in %s',
		( property, css, value ) => {
			expect( winning( probe(), property, [ sheet( css ) ] ) ).toBe(
				value
			);
		}
	);

	it.each( [
		[
			'font-variant-caps',
			'.cell { font: 10px mono; font-variant-caps: small-caps; }',
		],
		[ 'font-kerning', '.cell { font: 10px mono; }' ],
		[ 'background-position-x', '.cell { background: red; }' ],
		[ 'border-image-source', '.cell { border: 1px solid red; }' ],
	] )(
		'refuses %s where a shorthand it does not model resets it',
		( longhand, css ) => {
			expect( () =>
				winning( probe(), longhand, [ sheet( css ) ] )
			).toThrow( 'overlap' );
		}
	);

	it.each( [
		[ 'border-top-color', 'border: inherit' ],
		[ 'border-left-style', 'border: inherit' ],
		[ 'outline-width', 'outline: unset' ],
		[ 'background-color', 'background: initial' ],
		[ 'background-image', 'background: initial' ],
		[ 'padding-left', 'padding: revert' ],
		[ 'margin-top', 'margin-block: revert-layer' ],
	] )( 'answers %s with the keyword %s sets', ( longhand, declaration ) => {
		expect(
			winning( probe(), longhand, [
				sheet( `.cell { ${ declaration }; }` ),
			] )
		).toBe( declaration.split( ': ' )[ 1 ] );
	} );

	it.each( [
		[ 'url(k.svg) center/cover no-repeat #fff', '#fff' ],
		[ 'url(k.svg) 0 0/100% teal', 'teal' ],
		[ 'url(k.svg) center / cover', 'transparent' ],
	] )(
		'reads the colour of background: %s past its position and size',
		( value, color ) => {
			expect(
				winning( probe(), 'background-color', [
					sheet( `.cell { background: ${ value }; }` ),
				] )
			).toBe( color );
		}
	);

	it.each( [
		[ '1000 10px mono', '1000' ],
		[ '50 10px mono', '50' ],
	] )( 'reads the numeric weight of font: %s', ( value, weight ) => {
		expect(
			winning( probe(), 'font-weight', [
				sheet( `.cell { font: ${ value }; }` ),
			] )
		).toBe( weight );
	} );

	it.each( [ '000 10px mono', '1001 10px mono' ] )(
		'refuses a weight outside 1 to 1000: %s',
		( value ) => {
			expect( () =>
				winning( probe(), 'font-size', [
					sheet( `.cell { font: ${ value }; }` ),
				] )
			).toThrow( 'cannot place' );
		}
	);

	it.each( [
		[
			'font-size',
			'700 clamp(10px, 2vw, 14px) mono',
			'clamp(10px, 2vw, 14px)',
		],
		[ 'font-size', '1vmin mono', '1vmin' ],
		[ 'font-family', '12px var(--brand), serif', 'var(--brand), serif' ],
		[ 'font-size', '12px var(--brand), serif', '12px' ],
		[
			'font-family',
			'12px "Inter", var(--fallback)',
			'"Inter", var(--fallback)',
		],
	] )( 'reads %s from font: %s', ( longhand, value, expected ) => {
		expect(
			winning( probe(), longhand, [
				sheet( `.cell { font: ${ value }; }` ),
			] )
		).toBe( expected );
	} );

	// Every CSS shorthand, with one longhand it sets: each is modelled or refused.
	it.each( [
		[ 'animation', 'animation-name' ],
		[ 'background', 'background-size' ],
		[ 'background-position', 'background-position-x' ],
		[ 'border', 'border-image-source' ],
		[ 'border-block', 'border-top-color' ],
		[ 'border-block-color', 'border-bottom-color' ],
		[ 'border-image', 'border-image-slice' ],
		[ 'border-inline-end', 'border-right-width' ],
		[ 'border-radius', 'border-top-left-radius' ],
		[ 'border-style', 'border-left-style' ],
		[ 'column-rule', 'column-rule-color' ],
		[ 'columns', 'column-count' ],
		[ 'contain-intrinsic-size', 'contain-intrinsic-width' ],
		[ 'container', 'container-type' ],
		[ 'flex', 'flex-basis' ],
		[ 'flex-flow', 'flex-wrap' ],
		[ 'font', 'font-kerning' ],
		[ 'font-synthesis', 'font-synthesis-weight' ],
		[ 'font-variant', 'font-variant-caps' ],
		[ 'gap', 'row-gap' ],
		[ 'grid', 'grid-auto-flow' ],
		[ 'grid-area', 'grid-row-start' ],
		[ 'grid-column', 'grid-column-end' ],
		[ 'grid-gap', 'column-gap' ],
		[ 'grid-row-gap', 'row-gap' ],
		[ 'grid-column-gap', 'column-gap' ],
		[ 'grid-row', 'grid-row-end' ],
		[ 'grid-template', 'grid-template-areas' ],
		[ 'inset', 'bottom' ],
		[ 'inset-inline', 'left' ],
		[ 'list-style', 'list-style-type' ],
		[ 'margin', 'margin-left' ],
		[ 'margin-inline', 'margin-right' ],
		[ 'mask', 'mask-image' ],
		[ 'offset', 'offset-path' ],
		[ 'outline', 'outline-color' ],
		[ 'overflow', 'overflow-y' ],
		[ 'overscroll-behavior', 'overscroll-behavior-x' ],
		[ 'padding', 'padding-top' ],
		[ 'padding-block', 'padding-bottom' ],
		[ 'place-content', 'justify-content' ],
		[ 'place-items', 'align-items' ],
		[ 'place-self', 'justify-self' ],
		[ 'scroll-margin', 'scroll-margin-top' ],
		[ 'scroll-padding', 'scroll-padding-left' ],
		[ 'text-decoration', 'text-decoration-color' ],
		[ 'text-emphasis', 'text-emphasis-color' ],
		[ 'text-wrap', 'text-wrap-style' ],
		[ 'transition', 'transition-duration' ],
		[ 'white-space', 'white-space-collapse' ],
		[ 'word-wrap', 'overflow-wrap' ],
	] )( 'knows %s sets %s', ( shorthand, longhand ) => {
		let answer;
		try {
			answer = winning( probe(), longhand, [
				sheet( `.cell { ${ shorthand }: initial; }` ),
			] );
		} catch ( error ) {
			answer = error.message;
		}
		expect( [ shorthand, answer ] ).not.toEqual( [ shorthand, undefined ] );
	} );

	it.each( [
		[
			'background-color',
			'url(a.png) no-repeat, url(b.png) left top #f5f0e6',
			'#f5f0e6',
		],
		[
			'background-color',
			'url(a.png) no-repeat, url(b.png)',
			'transparent',
		],
		[
			'background-image',
			'url(a.png) no-repeat, none, linear-gradient(red, blue)',
			'url(a.png), none, linear-gradient(red, blue)',
		],
		[
			'background-color',
			'calc(10% + 2px) center / min(50%, 8px) no-repeat url(k.png) teal',
			'teal',
		],
		[
			'background-image',
			'-webkit-linear-gradient(red, blue) teal',
			'-webkit-linear-gradient(red, blue)',
		],
		[
			'background-image',
			'image-set("a.png" 1x) teal',
			'image-set("a.png" 1x)',
		],
		[
			'background-color',
			'cross-fade(url(a.png), url(b.png)) rgb(1, 2, 3)',
			'rgb(1, 2, 3)',
		],
		[
			'background-color',
			'element(#kea) color-mix(in srgb, red 50%, blue)',
			'color-mix(in srgb, red 50%, blue)',
		],
	] )(
		'reads %s from background: %s by its layers',
		( longhand, value, expected ) => {
			expect(
				winning( probe(), longhand, [
					sheet( `.cell { background: ${ value }; }` ),
				] )
			).toBe( expected );
		}
	);

	it.each( [
		[ 'font-weight', '400.5 10px mono', '400.5' ],
		[ 'font-weight', '1000.0 10px mono', '1000.0' ],
		[ 'font-style', 'oblique 10deg 10px mono', 'oblique 10deg' ],
		[ 'font-size', 'oblique -12.5deg 700 10px mono', '10px' ],
	] )( 'reads %s from font: %s', ( longhand, value, expected ) => {
		expect(
			winning( probe(), longhand, [
				sheet( `.cell { font: ${ value }; }` ),
			] )
		).toBe( expected );
	} );

	it( 'refuses a declaration replaced in place, or an at-rule turned rule', () => {
		const replaced = sheet( '.cell { color: teal; }' );
		winning( probe(), 'color', [ replaced ] );
		replaced.first.first.replaceWith(
			postcss.decl( { prop: 'color', value: 'plum' } )
		);
		expect( () => winning( probe(), 'color', [ replaced ] ) ).toThrow(
			'changed after it was read'
		);
		const swapped = sheet(
			'@media print { .x { color: red; } } .cell { color: teal; }'
		);
		winning( probe(), 'color', [ swapped ] );
		swapped.first.replaceWith(
			postcss
				.rule( { selector: '.cell' } )
				.append( { prop: 'color', value: 'plum' } )
		);
		expect( () => winning( probe(), 'color', [ swapped ] ) ).toThrow(
			'changed after it was read'
		);
	} );

	it.each( [
		[ 'gap', '.cell { grid-gap: 1px; }' ],
		[ 'grid-gap', '.cell { gap: 1px; }' ],
		[ 'grid-row', '.cell { grid-area: 1 / 2; }' ],
		[ 'border-image', '.cell { border: 1px solid red; }' ],
		[ 'white-space', '.cell { text-wrap: balance; }' ],
		[ 'grid-template', '.cell { grid: auto / auto; }' ],
	] )(
		'refuses %s where a shorthand sharing its longhands meets it',
		( asked, css ) => {
			expect( () => winning( probe(), asked, [ sheet( css ) ] ) ).toThrow(
				'overlap'
			);
		}
	);

	it.each( [
		[ 'background-color', 'url(a.png) var(--pos)', 'to a var()' ],
		[ 'background-color', 'foo(1) teal', 'does not model' ],
		[ 'background-image', 'foo(1) teal', 'does not model' ],
	] )( 'refuses %s from background: %s', ( longhand, value, message ) => {
		expect( () =>
			winning( probe(), longhand, [
				sheet( `.cell { background: ${ value }; }` ),
			] )
		).toThrow( message );
	} );

	it.each( [
		[
			'background-image',
			'-webkit-gradient(linear, 0 0, 0 100%, from(red)) teal',
			'-webkit-gradient(linear, 0 0, 0 100%, from(red))',
		],
		[
			'background-image',
			'image(url(a.png), red) teal',
			'image(url(a.png), red)',
		],
		[
			'background-image',
			'Linear-Gradient(red, blue) teal',
			'Linear-Gradient(red, blue)',
		],
		[ 'background-color', 'image(url(a.png)) teal', 'teal' ],
	] )( 'reads %s from background: %s', ( longhand, value, expected ) => {
		expect(
			winning( probe(), longhand, [
				sheet( `.cell { background: ${ value }; }` ),
			] )
		).toBe( expected );
	} );

	it( 'keeps a quoted family whole across a slash, and refuses oblique var()', () => {
		const quoted = [ sheet( '.cell { font: 12px "A/B"; }' ) ];
		expect( winning( probe(), 'font-size', quoted ) ).toBe( '12px' );
		expect( winning( probe(), 'font-family', quoted ) ).toBe( '"A/B"' );
		expect( () =>
			winning( probe(), 'font-style', [
				sheet( '.cell { font: oblique var(--a) 10px mono; }' ),
			] )
		).toThrow( 'to a var()' );
	} );

	it( 'reads function names in any case', () => {
		expect( resolveVars( 'VAR(--c)', { '--c': 'teal' } ) ).toBe( 'teal' );
		expect(
			winning( probe(), 'border-top-width', [
				sheet( '.cell { border: CALC(1px + 2px) solid teal; }' ),
			] )
		).toBe( 'CALC(1px + 2px)' );
	} );

	it( 'refuses a sheet holding a nested rule, naming it', () => {
		expect( () =>
			winning( probe(), 'color', [
				postcss.parse(
					'.root { color: teal; & .cell { color: plum; } }'
				),
			] )
		).toThrow(
			'css-reader: & .cell nests inside .root; compile the sheet flat'
		);
	} );

	it.each( [
		[ 'font-size', '700 var(--np-text-2xs) var(--font-mono)' ],
		[ 'font-weight', 'var(--x) Arial' ],
		[ 'font-style', 'var(--x) Arial' ],
		[ 'font-style', 'oblique var(--x) Arial' ],
		[ 'line-height', 'var(--x) Arial' ],
		[ 'line-height', '12px var(--f)' ],
	] )(
		'refuses %s where a var() may stand for it in font: %s',
		( longhand, value ) => {
			expect( () =>
				winning( probe(), longhand, [
					sheet( `.cell { font: ${ value }; }` ),
				] )
			).toThrow( 'to a var()' );
		}
	);

	it( 'reads all: unset as every longhand it resets, where it wins', () => {
		document.body.innerHTML =
			'<div class="root"><button id="probe" class="reset">Kea</button></div>';
		const button = document.getElementById( 'probe' );
		const sheets = [
			sheet(
				'button { color: plum; padding: 4px; } .reset { all: unset; }' +
					'.root .reset { cursor: pointer; } .reset { --tone: teal; }'
			),
		];
		expect( winning( button, 'color', sheets ) ).toBe( 'unset' );
		expect( winning( button, 'padding-left', sheets ) ).toBe( 'unset' );
		expect( winning( button, 'cursor', sheets ) ).toBe( 'pointer' );
		expect( winning( button, '--tone', sheets ) ).toBe( 'teal' );
		expect( winning( button, 'direction', sheets ) ).toBeUndefined();
		expect( () =>
			winning( button, 'color', [ sheet( '.reset { all: 0; }' ) ] )
		).toThrow( 'all: 0' );
	} );

	it.each( [
		[ '-webkit-text-stroke', '-webkit-text-stroke-color' ],
		[ 'mask-border', 'mask-border-slice' ],
		[ '-webkit-mask', 'mask-image' ],
	] )( 'refuses %s meeting %s', ( shorthand, longhand ) => {
		expect( () =>
			winning( probe(), longhand, [
				sheet( `.cell { ${ shorthand }: x; }` ),
			] )
		).toThrow( 'overlap' );
	} );

	it.each( [
		[ 'font-weight', 'font: BOLD 10px mono', 'BOLD' ],
		[ 'font-style', 'font: Italic 10px mono', 'Italic' ],
		[ 'border-top-style', 'border: 1px SOLID red', 'SOLID' ],
		[ 'border-top-color', 'border: 1px SOLID red', 'red' ],
		[
			'background-color',
			'background: Center/Cover No-Repeat teal',
			'teal',
		],
		[ 'line-height', 'font: INHERIT', 'INHERIT' ],
	] )(
		'reads %s from %s in any case',
		( longhand, declaration, expected ) => {
			expect(
				winning( probe(), longhand, [
					sheet( `.cell { ${ declaration }; }` ),
				] )
			).toBe( expected );
		}
	);

	it.each( [
		[ 'mask-border-slice', '.cell { mask: url(a.svg); }' ],
		[ 'mask-border-mode', '.cell { -webkit-mask: url(a.svg); }' ],
		[ 'scroll-margin-block-start', '.cell { scroll-margin: 4px; }' ],
		[ 'scroll-padding-left', '.cell { scroll-padding-inline: 4px; }' ],
		[ 'scroll-margin-top', '.cell { scroll-margin-block: 4px; }' ],
		[ 'border-start-end-radius', '.cell { border-radius: 4px; }' ],
		[ 'animation-timeline', '.cell { animation: spin 1s; }' ],
		[ 'animation-range-start', '.cell { animation: spin 1s; }' ],
		[ 'animation-composition', '.cell { animation: spin 1s; }' ],
	] )( 'refuses %s where %s resets it', ( longhand, css ) => {
		expect( () => winning( probe(), longhand, [ sheet( css ) ] ) ).toThrow(
			'overlap'
		);
	} );

	it.each( [
		[ 'appearance', '.cell { -moz-appearance: none; }', 'none' ],
		[
			'mask-image',
			'.cell { -webkit-mask-image: url(a.svg); }',
			'url(a.svg)',
		],
		[
			'-webkit-mask-image',
			'.cell { mask-image: url(b.svg); }',
			'url(b.svg)',
		],
		[
			'scroll-margin-top',
			'.cell { scroll-margin-block-start: 6px; }',
			'6px',
		],
		[
			'border-bottom-right-radius',
			'.cell { border-end-end-radius: 3px; }',
			'3px',
		],
	] )(
		'answers %s through its prefixed or logical alias in %s',
		( longhand, css, value ) => {
			expect( winning( probe(), longhand, [ sheet( css ) ] ) ).toBe(
				value
			);
		}
	);

	it( 'reads a var() in the size place as its caller says, as shorthandSize() does', () => {
		const sheets = [
			sheet( '.cell { font: var(--np-text-s) var(--f); }' ),
		];
		const isSizeVar = ( word ) => word.startsWith( 'var(--np-text-' );
		expect( () => winning( probe(), 'font-size', sheets ) ).toThrow(
			'to a var()'
		);
		expect( winning( probe(), 'font-size', sheets, { isSizeVar } ) ).toBe(
			'var(--np-text-s)'
		);
		expect(
			shorthandSize( 'var(--np-text-s) var(--f)', { isSizeVar } )
		).toBe( 'var(--np-text-s)' );
	} );

	it( 'reads a bare 0 as a size', () => {
		expect(
			winning( probe(), 'font-size', [
				sheet( '.cell { font: 0 Arial; }' ),
			] )
		).toBe( '0' );
	} );

	it( 'refuses a sheet changed after it was read', () => {
		const changing = sheet(
			'.cell { color: teal; } .elsewhere { color: plum; }'
		);
		expect( winning( probe(), 'color', [ changing ] ) ).toBe( 'teal' );
		changing.last.selector = '.cell.cell';
		expect( () => winning( probe(), 'color', [ changing ] ) ).toThrow(
			'changed after it was read'
		);
		const growing = sheet( '.cell { color: teal; }' );
		winning( probe(), 'color', [ growing ] );
		growing.append( '.cell { color: plum; }' );
		expect( () => winning( probe(), 'color', [ growing ] ) ).toThrow(
			'changed after it was read'
		);
	} );

	it( 'ranks an !important declaration above every normal one', () => {
		const sheets = [
			sheet(
				'.cell { color: teal !important; } .root #probe.cell { color: plum; }' +
					'#probe { outline: 2px solid red !important; }' +
					'#probe.cell { outline-color: navy !important; }'
			),
		];
		expect( winning( probe(), 'color', sheets ) ).toBe( 'teal' );
		expect( winning( probe(), 'outline-color', sheets ) ).toBe( 'navy' );
		expect( winning( probe(), 'outline-width', sheets ) ).toBe( '2px' );
	} );

	it( 'reads the outline family through its shorthand', () => {
		const sheets = [
			sheet( '.cell { outline: var(--ring) dotted 3px; }' ),
		];
		expect( winning( probe(), 'outline-style', sheets ) ).toBe( 'dotted' );
		expect( winning( probe(), 'outline-width', sheets ) ).toBe( '3px' );
		expect( winning( probe(), 'outline-color', sheets ) ).toBe(
			'var(--ring)'
		);
	} );

	const shorthand = ( longhand, value ) => [
		sheet(
			`.cell { ${
				{ 'line-height': 'font' }[ longhand ] ??
				longhand.split( '-' )[ 0 ]
			}: ${ value }; }`
		),
	];

	it.each( [
		[ 'font-size', 'var(--w) 10px/1 sans', '10px' ],
		[ 'font-size', 'var(--w) 10px sans', '10px' ],
		[ 'font-size', 'var(--s) mono', 'var(--s)' ],
		[ 'border-top-color', 'var(--w) solid red', 'red' ],
		[ 'border-top-width', 'var(--w) solid red', 'var(--w)' ],
		[ 'border-top-color', '1px solid var(--edge)', 'var(--edge)' ],
		[ 'border-top-width', 'calc(1px + 2px) solid teal', 'calc(1px + 2px)' ],
		[ 'border-top-color', 'max(1px, 0.1em) solid teal', 'teal' ],
		[
			'outline-width',
			'clamp(1px, 2px, 3px) dotted',
			'clamp(1px, 2px, 3px)',
		],
		[ 'padding-left', '1px 2px 3px var(--four)', 'var(--four)' ],
		[ 'background-color', 'var(--x) #f5f0e6', '#f5f0e6' ],
		[ 'font-size', '14px Helvetica Neue, sans-serif', '14px' ],
		[
			'font-family',
			'14px Helvetica Neue, sans-serif',
			'Helvetica Neue, sans-serif',
		],
		[ 'line-height', 'inherit', 'inherit' ],
		[ 'font-weight', 'unset', 'unset' ],
		[ 'font-style', 'revert', 'revert' ],
		[ 'font-size', 'initial', 'initial' ],
	] )( 'reads %s by position from %s', ( longhand, value, expected ) => {
		expect(
			winning( probe(), longhand, shorthand( longhand, value ) )
		).toBe( expected );
	} );

	it.each( [
		[ 'font-weight', 'var(--w) 10px sans' ],
		[ 'font-size', 'var(--a) var(--b)' ],
		[ 'font-size', 'var(--np-font)' ],
		[ 'border-top-color', '1px var(--a) var(--b)' ],
		[ 'border-top-color', 'var(--line)' ],
		[ 'padding-top', 'var(--pad)' ],
		[ 'margin-left', '0 var(--gutter)' ],
		[ 'padding-top', 'var(--a) var(--b)' ],
		[ 'background-color', 'var(--x)' ],
		[ 'background-image', 'var(--x)' ],
		[ 'font-size', '700 var(--np-text-secondary) var(--font-mono)' ],
	] )(
		'refuses %s where a var() leaves %s ambiguous',
		( longhand, value ) => {
			expect( () =>
				winning( probe(), longhand, shorthand( longhand, value ) )
			).toThrow( 'to a var()' );
		}
	);

	it.each( [ 'bold 14px', 'small-caps nonsense 10px mono', 'menu' ] )(
		'refuses a font shorthand it cannot place: %s',
		( value ) => {
			expect( () =>
				winning( probe(), 'font-size', [
					sheet( `.cell { font: ${ value }; }` ),
				] )
			).toThrow( 'font:' );
		}
	);

	it( 'reads every longhand a CSS-wide keyword on the real font shorthand sets', () => {
		const ui = postcss.parse(
			require( 'sass' ).compile(
				require( 'path' ).resolve(
					__dirname,
					'../../ui/newspack-nodes-ui.scss'
				)
			).css
		);
		document.body.innerHTML =
			'<div class="newspack-nodes-ui newspack-nodes-ui">' +
			'<button id="link" class="button-link">Kea</button>' +
			'<div class="nodes-tab-host__tab" id="tab">Moa</div></div>';
		const link = document.getElementById( 'link' );
		const tab = document.getElementById( 'tab' );
		for ( const longhand of [
			'font-family',
			'font-weight',
			'font-style',
			'line-height',
		] ) {
			expect( [ longhand, winning( link, longhand, [ ui ] ) ] ).toEqual( [
				longhand,
				'inherit',
			] );
		}
		expect( winning( tab, 'font-size', [ ui ] ) ).toBe( '13px' );
		expect( winning( tab, 'line-height', [ ui ] ) ).toBe( 'inherit' );
	} );

	it( 'refuses an unclosed var()', () => {
		expect( () => resolveVars( 'var(--kea', {} ) ).toThrow(
			'unclosed var()'
		);
	} );

	it( 'matches :hover on the element named hovered and its ancestors', () => {
		const sheets = [
			sheet(
				'.cell { color: teal; } .cell:hover { color: plum; }' +
					'.root:hover .cell { outline-color: navy; }'
			),
		];
		const cell = probe();
		expect( winning( cell, 'color', sheets ) ).toBe( 'teal' );
		expect( winning( cell, 'color', sheets, { hovered: cell } ) ).toBe(
			'plum'
		);
		expect(
			winning( cell, 'outline-color', sheets, { hovered: cell } )
		).toBe( 'navy' );
		expect( cell.hasAttribute( 'data-css-reader-hovered' ) ).toBe( false );
	} );

	it( 'refuses a selector the DOM cannot read, naming it', () => {
		expect( () =>
			winning( probe(), 'color', [
				sheet( '.cell:unknown-pseudo { color: teal; }' ),
			] )
		).toThrow( '.cell:unknown-pseudo' );
	} );

	it( 'answers undefined when every rule leaves a longhand unset', () => {
		expect(
			winning( probe(), 'outline-color', [
				sheet( '.cell { color: teal; }' ),
			] )
		).toBeUndefined();
	} );
} );

describe( 'the picker on the real sheet', () => {
	// Picker mode paints with !important over every row's own paint.
	const ui = postcss.parse(
		require( 'sass' ).compile(
			require( 'path' ).resolve(
				__dirname,
				'../../ui/newspack-nodes-ui.scss'
			)
		).css
	);

	afterEach( () => {
		document.documentElement.classList.remove( 'newspack-nodes-asking' );
	} );

	it( 'gives a picked row its tint, its ring and the help cursor', () => {
		document.documentElement.classList.add( 'newspack-nodes-asking' );
		document.body.innerHTML =
			'<div class="newspack-nodes-ui newspack-nodes-ui">' +
			'<button id="probe" class="button" data-ask="kea" data-ask-picked>Kea</button></div>';
		const picked = document.getElementById( 'probe' );
		const sheets = [
			ui,
			postcss.parse(
				'.newspack-nodes-ui #probe.button { cursor: pointer; background-image: none; outline: 0 none; }'
			),
		];
		expect( winning( picked, 'cursor', sheets ) ).toBe( 'help' );
		expect( winning( picked, 'background-image', sheets ) ).toMatch(
			/^linear-gradient\(/
		);
		expect( winning( picked, 'outline-style', sheets ) ).toBe( 'solid' );
		document.documentElement.classList.remove( 'newspack-nodes-asking' );
		expect( winning( picked, 'cursor', sheets ) ).toBe( 'pointer' );
	} );
} );

describe( 'computed', () => {
	it.each( [
		[ 'inherit', 'teal' ],
		[ 'unset', 'teal' ],
		[ 'initial', 'plum' ],
	] )(
		'reads a custom property set to %s as the browser does',
		( keyword, color ) => {
			document.body.innerHTML =
				'<div class="p"><p id="probe" class="c"></p></div>';
			const sheets = [
				postcss.parse(
					`.p { --ink: teal; } .c { --ink: ${ keyword }; color: var(--ink, plum); }`
				),
			];
			expect(
				computed( document.getElementById( 'probe' ), 'color', sheets )
			).toBe( color );
		}
	);

	it( 'resolves each custom property the element or an ancestor wins', () => {
		document.body.innerHTML =
			'<div class="root"><div class="bad"><p id="probe" class="cell"></p></div></div>';
		const sheets = [
			postcss.parse(
				'.root { --edge: var(--tone); --tone: grey; }' +
					'.bad { --edge: var(--oxide, red); }' +
					'.cell { border-top-color: var(--edge); color: var(--ink, black); }'
			),
		];
		const probe = document.getElementById( 'probe' );
		expect( computed( probe, 'border-top-color', sheets ) ).toBe( 'red' );
		expect( computed( probe, 'color', sheets ) ).toBe( 'black' );
		expect(
			computed( probe, 'outline-color', [
				postcss.parse( '.cell { outline-color: var(--unset); }' ),
			] )
		).toBe( GUARANTEED_INVALID );
	} );

	it( 'takes the fallback where a custom property is itself invalid', () => {
		document.body.innerHTML = '<p id="probe" class="c"></p>';
		expect(
			computed( document.getElementById( 'probe' ), 'color', [
				postcss.parse(
					'.c { --a: var(--missing); color: var(--a, plum); }'
				),
			] )
		).toBe( 'plum' );
	} );

	it( 'resolves a custom property afresh on the ancestor that sets it', () => {
		document.body.innerHTML =
			'<div class="p"><p id="probe" class="c"></p></div>';
		const sheets = [
			postcss.parse(
				'.p { --a: var(--b); --b: red; } .c { --b: var(--a); color: var(--b); }'
			),
		];
		expect(
			computed( document.getElementById( 'probe' ), 'color', sheets )
		).toBe( 'red' );
	} );

	it( 'refuses a custom property that reads itself, naming it', () => {
		document.body.innerHTML = '<p id="probe" class="cell"></p>';
		const sheets = [
			postcss.parse(
				'.cell { --a: var(--b); --b: var(--a, 1px); outline-width: var(--a); }'
			),
		];
		expect( () =>
			computed(
				document.getElementById( 'probe' ),
				'outline-width',
				sheets
			)
		).toThrow( '--a reads itself through --a > --b > --a' );
	} );
} );

describe( 'resolved', () => {
	it( 'maps every property a matching rule sets to its winner', () => {
		document.body.innerHTML = '<p id="probe" class="cell"></p>';
		expect(
			resolved( document.getElementById( 'probe' ), [
				postcss.parse(
					'.cell { gap: 4px; padding: 2px; } #probe { gap: 7px; }'
				),
			] )
		).toEqual( {
			gap: '7px',
			'padding-top': '2px',
			'padding-right': '2px',
			'padding-bottom': '2px',
			'padding-left': '2px',
		} );
	} );

	it( 'answers a record read at call time, refusing a covered shorthand', () => {
		document.body.innerHTML = '<p id="probe" class="cell"></p>';
		const map = resolved( document.getElementById( 'probe' ), [
			postcss.parse(
				'.cell { padding: 2px 4px; color: teal; } .gone .cell { color: plum; }'
			),
		] );
		document.body.innerHTML = '<div class="gone"></div>';
		expect( map.color ).toBe( 'teal' );
		expect( map[ 'padding-left' ] ).toBe( '4px' );
		for ( const shorthand of [
			'padding',
			'background',
			'font',
			'inset',
		] ) {
			expect( () => map[ shorthand ] ).toThrow(
				`${ shorthand } is a shorthand; ask a longhand`
			);
		}
	} );

	it( 'enumerates the values it read, refusing a value only where it is read', () => {
		document.body.innerHTML = '<p id="probe" class="cell"></p>';
		const map = resolved( document.getElementById( 'probe' ), [
			postcss.parse( '.cell { padding: var(--pad); color: teal; }' ),
		] );
		expect( { ...map } ).toEqual( { color: 'teal' } );
		expect( map ).toEqual( { color: 'teal' } );
		expect( () => map[ 'padding-top' ] ).toThrow( 'to a var()' );
	} );

	it.each( [
		[ 'flex-grow', '.cell { flex: 1; }' ],
		[ 'background-position', '.cell { background: teal; }' ],
	] )(
		'refuses %s where an outside shorthand sets it, as winning() does',
		( longhand, css ) => {
			document.body.innerHTML = '<p id="probe" class="cell"></p>';
			const map = resolved( document.getElementById( 'probe' ), [
				postcss.parse( css ),
			] );
			expect( () => map[ longhand ] ).toThrow( 'overlap' );
		}
	);

	it( 'refuses a property it cannot model only where it is read', () => {
		document.body.innerHTML = '<p id="probe" class="cell"></p>';
		const map = resolved( document.getElementById( 'probe' ), [
			postcss.parse(
				'.cell { background-size: 8px; color: teal; } #probe { background: none; }'
			),
		] );
		expect( map.color ).toBe( 'teal' );
		expect( () => map[ 'background-size' ] ).toThrow(
			'background and background-size overlap'
		);
	} );
} );
