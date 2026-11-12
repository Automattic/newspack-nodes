/**
 * A submit button is an `<input>`, so the text-field rule matches it unless
 * buttons are excluded. Its `color` loses to the button role on specificity,
 * but `-webkit-text-fill-color` has no competitor and paints over `color` —
 * which rendered "Save Settings" in field ink on the primary fill (1.25:1).
 */

import path from 'path';
import * as sass from 'sass';
import postcss from 'postcss';

const ROOT = path.resolve( __dirname, '../../..' );
const UI_SCSS = path.join( ROOT, 'src/ui/newspack-nodes-ui.scss' );
const stylesheet = postcss.parse( sass.compile( UI_SCSS ).css, {
	from: UI_SCSS,
} );

// Split a selector list on its TOP-LEVEL commas only. A naive split shreds
// `:not(.a, .b)` into two invalid fragments, which jsdom then refuses — a
// silent false pass that hid the focus rule on the first run.
function splitSelectorList( selector ) {
	return topLevel( selector ).filter( ( s ) => ! s.includes( '::' ) );
}

function topLevel( selector ) {
	const parts = [];
	let depth = 0;
	let current = '';
	for ( const ch of selector ) {
		if ( ch === '(' ) {
			depth += 1;
		} else if ( ch === ')' ) {
			depth -= 1;
		}
		if ( ',' === ch && 0 === depth ) {
			parts.push( current );
			current = '';
			continue;
		}
		current += ch;
	}
	parts.push( current );
	return parts
		.map( ( s ) => s.trim().replace( /\s+/g, ' ' ) )
		.filter( Boolean );
}

// Every simple selector that declares `prop`.
function selectorsDeclaring( prop ) {
	const out = [];
	stylesheet.walkDecls( prop, ( decl ) => {
		const rule = decl.parent;
		if ( rule && rule.selector ) {
			out.push( ...splitSelectorList( rule.selector ) );
		}
	} );
	return out;
}

function matchesButton( selector, button ) {
	try {
		return button.matches(
			selector.replace( /:(hover|focus|active)(?![\w-])/g, '' )
		);
	} catch ( _err ) {
		return false;
	}
}

describe( 'field styling scope', () => {
	let button;

	beforeEach( () => {
		document.body.innerHTML =
			'<div class="wrap newspack-nodes-theme newspack-nodes-ui">' +
			'<p class="submit"><input type="submit" id="submit" ' +
			'class="button button-primary" value="Save Settings"></p>' +
			'</div>';
		button = document.getElementById( 'submit' );
	} );

	it( 'never paints a submit button with the field ink', () => {
		const painting = selectorsDeclaring( '-webkit-text-fill-color' ).filter(
			( sel ) => matchesButton( sel, button )
		);
		expect( painting ).toEqual( [] );
	} );

	// The field rule also carries the square corners, the field border and the
	// field padding, and it outranks `.button` — which is why the submit input
	// rendered square beside a rounded <button>.
	it( 'gives a submit button none of the text-field declarations', () => {
		const fieldish = [];
		stylesheet.walkRules( ( rule ) => {
			const css = rule.toString();
			if ( ! /--np-field-|--field-radius/.test( css ) ) {
				return;
			}
			splitSelectorList( rule.selector ).forEach( ( sel ) => {
				if ( matchesButton( sel, button ) ) {
					fieldish.push( sel );
				}
			} );
		} );
		expect( fieldish ).toEqual( [] );
	} );

	// The `@longform` note in _focus.scss: buttons ring on KEYBOARD focus only,
	// or the ring sits on whatever you last clicked. Its `button` selector does
	// not cover <input type="submit">, which must not take the text-field branch.
	it( 'does not give a submit button a plain :focus ring', () => {
		const ringed = [];
		stylesheet.walkRules( ( rule ) => {
			if ( ! /:focus(?!-visible)/.test( rule.selector ) ) {
				return;
			}
			splitSelectorList( rule.selector ).forEach( ( sel ) => {
				if (
					! sel.includes( ':focus-visible' ) &&
					matchesButton( sel, button )
				) {
					ringed.push( sel );
				}
			} );
		} );
		expect( ringed ).toEqual( [] );
	} );

	it( 'still styles a real text field', () => {
		document.body.innerHTML =
			'<div class="newspack-nodes-theme newspack-nodes-ui">' +
			'<input type="text" id="field" value="x"></div>';
		const field = document.getElementById( 'field' );
		const painting = selectorsDeclaring( '-webkit-text-fill-color' ).filter(
			( sel ) => matchesButton( sel, field )
		);
		expect( painting.length ).toBeGreaterThan( 0 );
	} );
} );

const read = require( '../../build-kit/css-reader.cjs' );

// The product tokens the field tokens fall back to, set on the theme root.
const theme = postcss.parse(
	sass.compile( path.join( ROOT, 'src/theme/newspack-theme.scss' ) ).css
);

// The value a longhand wins, every custom property it reads resolved.
const winning = ( element, longhand, sheets = [ stylesheet ] ) =>
	read.computed( element, longhand, [ theme, ...sheets ] );

/**
 * One element under the UI root, or under a dark skin's root.
 *
 * @param {string}  markup The element, carrying `id="probe"`.
 * @param {boolean} dark   Whether the root wears the aurora skin.
 * @return {Element} It.
 */
const under = ( markup, dark = false ) => {
	const root = `newspack-nodes-theme newspack-nodes-ui${
		dark ? ' newspack-nodes-skin-root' : ''
	}`;
	document.body.innerHTML = `<div class="${
		dark ? 'theme-aurora' : ''
	}"><div class="${ root }">${ markup }</div></div>`;
	return document.getElementById( 'probe' );
};

// The product tokens a root without a skin falls back to.
const OXIDE = '#b32d2e';
const FIELD_BORDER = '#ccc';
const OXIDE_TEXT = '#b32d2e';
const CHECKED = '#003da5';

// jsdom never matches :focus-within, so a class of equal weight stands in.
const focusWithin = postcss.parse(
	stylesheet.toString().replaceAll( ':focus-within', '.is-focus-within' )
);

// Which chevron an image is: the light one is filled white.
const chevron = ( image ) => {
	if ( undefined === image || 'none' === image ) {
		return 'none';
	}
	return image.includes( '%23ffffff' ) ? 'light' : 'dark';
};

describe( 'native select chrome', () => {
	it( 'clears the chevron with its right padding, past the field rule', () => {
		document.body.innerHTML =
			'<div class="newspack-nodes-theme newspack-nodes-ui">' +
			'<select id="kind-6604"><option>-- Select Type --</option></select></div>';
		expect(
			winning( document.getElementById( 'kind-6604' ), 'padding-right' )
		).toBe( '22px' );
	} );

	// The browser draws a listbox for `multiple` or a size above 1 alone.
	const LISTBOXES = [
		[ 'multiple', 'multiple' ],
		[ 'size 4', 'size="4"' ],
		[ 'size 12', 'size="12"' ],
	];
	const listboxOf = ( attrs, dark = false ) =>
		under(
			`<select id="probe" ${ attrs }><option>Ash</option></select>`,
			dark
		);

	it.each( [
		...LISTBOXES,
		[
			'SelectControl multiple',
			'class="components-select-control__input" multiple',
		],
	] )( 'gives a %s listbox no chevron in any skin', ( label, attrs ) => {
		for ( const dark of [ false, true ] ) {
			const listbox = listboxOf( attrs, dark );
			expect( chevron( winning( listbox, 'background-image' ) ) ).toBe(
				'none'
			);
			expect( winning( listbox, 'padding-right' ) ).not.toBe( '22px' );
		}
	} );

	it.each( LISTBOXES )(
		'leaves a %s listbox its native list chrome inside the field frame',
		( label, attrs ) => {
			const listbox = listboxOf( attrs );
			expect( winning( listbox, 'appearance' ) ).toBe( 'auto' );
			expect( winning( listbox, 'padding-right' ) ).toBe( '10px' );
			expect( winning( listbox, 'border-top-color' ) ).toBe(
				FIELD_BORDER
			);
		}
	);

	// A size the browser reads as one row or fewer drops down.
	it.each( [
		[ 'no size', '' ],
		[ 'size 1', 'size="1"' ],
		[ 'size 0', 'size="0"' ],
		[ 'an empty size', 'size=""' ],
		[ 'a size that is not a number', 'size="abc"' ],
		[ 'SelectControl', 'class="components-select-control__input"' ],
	] )( "gives a select with %s the skin's chevron", ( label, attrs ) => {
		const markup = `<select id="probe" ${ attrs }><option>Ash</option></select>`;
		const light = under( markup );
		expect( chevron( winning( light, 'background-image' ) ) ).toBe(
			'dark'
		);
		expect( winning( light, 'padding-right' ) ).toBe( '22px' );
		expect(
			chevron( winning( under( markup, true ), 'background-image' ) )
		).toBe( 'light' );
	} );
} );

describe( 'an invalid field', () => {
	it.each( [
		[ 'text input', '<input id="probe" type="text" aria-invalid="true">' ],
		[ 'select', '<select id="probe" aria-invalid="true"></select>' ],
		[ 'textarea', '<textarea id="probe" aria-invalid="true"></textarea>' ],
	] )(
		'edges an invalid %s in oxide, past the field rule',
		( label, markup ) => {
			expect( winning( under( markup ), 'border-top-color' ) ).toBe(
				OXIDE
			);
		}
	);

	it( 'leaves a valid field its field border', () => {
		expect(
			winning(
				under( '<input id="probe" type="text" aria-invalid="false">' ),
				'border-top-color'
			)
		).toBe( FIELD_BORDER );
	} );

	// The token field's frame draws the border its entry box leaves off.
	it.each( [
		[ 'true', OXIDE ],
		[ 'false', FIELD_BORDER ],
	] )(
		'edges a token field frame whose entry is aria-invalid=%s',
		( invalid, color ) => {
			const frame = under(
				'<div id="probe" class="newspack-nodes-token-field">' +
					'<input class="newspack-nodes-token-field__entry" ' +
					`aria-invalid="${ invalid }"></div>`
			);
			expect( winning( frame, 'border-top-color' ) ).toBe( color );
		}
	);

	// A stock frame draws the border for the field inside it.
	it.each( [
		[ 'FormTokenField', 'components-form-token-field__input-container' ],
		[
			'ComboboxControl',
			'components-combobox-control__suggestions-container',
		],
	] )( 'edges a stock %s frame around an invalid input', ( label, frame ) => {
		for ( const [ invalid, color ] of [
			[ 'true', OXIDE ],
			[ 'false', FIELD_BORDER ],
		] ) {
			const probe = under(
				`<div id="probe" class="${ frame }">` +
					'<input class="components-form-token-field__input" ' +
					`aria-invalid="${ invalid }"></div>`
			);
			expect( winning( probe, 'border-top-color' ) ).toBe( color );
		}
	} );

	it( 'edges a SelectControl backdrop whose select is invalid', () => {
		const backdrop = under(
			'<div class="components-input-control__container">' +
				'<select class="components-select-control__input" ' +
				'aria-invalid="true"></select>' +
				'<div id="probe" class="components-input-control__backdrop">' +
				'</div></div>'
		);
		expect( winning( backdrop, 'border-top-color' ) ).toBe( OXIDE );
	} );

	// InputControl's backdrop draws its border, focused or not.
	it.each( [
		[ 'true', false, OXIDE ],
		[ 'true', true, OXIDE ],
		[ 'false', true, FIELD_BORDER ],
	] )(
		'edges an InputControl backdrop whose input is aria-invalid=%s, focused %s',
		( invalid, focused, color ) => {
			const backdrop = under(
				`<div class="components-input-control__container${
					focused ? ' is-focus-within' : ''
				}">` +
					'<input class="components-input-control__input" ' +
					`aria-invalid="${ invalid }">` +
					'<div id="probe" class="components-input-control__backdrop">' +
					'</div></div>'
			);
			const sheets = [ focused ? focusWithin : stylesheet ];
			expect( winning( backdrop, 'border-top-color', sheets ) ).toBe(
				color
			);
			expect( winning( backdrop, 'outline-style', sheets ) ).toBe(
				focused ? 'none' : undefined
			);
		}
	);
} );

// A refused field marks its wrapper; every control in it and its label show.
describe( 'a field marked invalid', () => {
	const inField = ( markup ) =>
		under( `<div class="newspack-nodes-field-invalid">${ markup }</div>` );

	it.each( [
		[ 'text input', '<input id="probe" type="text">' ],
		[ 'select', '<select id="probe"><option>Ash</option></select>' ],
		[ 'listbox', '<select id="probe" multiple></select>' ],
		[ 'textarea', '<textarea id="probe"></textarea>' ],
		[ 'colour input', '<input id="probe" type="color">' ],
		[
			'token field',
			'<div id="probe" class="newspack-nodes-token-field">' +
				'<input class="newspack-nodes-token-field__entry"></div>',
		],
		[
			'FormTokenField',
			'<div id="probe" class="components-form-token-field__input-container"></div>',
		],
		[
			'ComboboxControl',
			'<div id="probe" class="components-combobox-control__suggestions-container"></div>',
		],
		[ 'checkbox', '<input id="probe" type="checkbox">' ],
		[ 'checked checkbox', '<input id="probe" type="checkbox" checked>' ],
		[ 'rich-text field', '<div id="probe" contenteditable="true"></div>' ],
	] )( 'edges its %s in oxide', ( label, markup ) => {
		expect( winning( inField( markup ), 'border-top-color' ) ).toBe(
			OXIDE
		);
	} );

	// A state that reads the field token follows the mark with no rule of its own.
	it( 'carries the mark into a disabled state that reads the token', () => {
		const sheets = [
			stylesheet,
			postcss.parse(
				'#probe:disabled { border-color: var(--np-field-border); opacity: 0.6; }'
			),
		];
		expect(
			winning(
				inField( '<input id="probe" type="text" disabled>' ),
				'border-top-color',
				sheets
			)
		).toBe( OXIDE );
		expect(
			winning(
				under( '<input id="probe" type="text" disabled>' ),
				'border-top-color',
				sheets
			)
		).toBe( FIELD_BORDER );
	} );

	it( 'leaves a field outside the mark its field border', () => {
		expect(
			winning(
				under( '<input id="probe" type="text">' ),
				'border-top-color'
			)
		).toBe( FIELD_BORDER );
	} );

	it.each( [ 'checked', 'indeterminate' ] )(
		'fills a %s checkbox from the checked token, oxide when marked',
		( state ) => {
			const box = ( markup ) => {
				const input = markup( '<input id="probe" type="checkbox">' );
				input[ state ] = true;
				return input;
			};
			expect( winning( box( inField ), 'background-color' ) ).toBe(
				OXIDE
			);
			expect( winning( box( under ), 'background-color' ) ).toBe(
				CHECKED
			);
		}
	);

	it( 'edges an editable that carries aria-invalid itself', () => {
		expect(
			winning(
				under(
					'<div id="probe" contenteditable="true" aria-invalid="true"></div>'
				),
				'border-top-color'
			)
		).toBe( OXIDE );
	} );

	it( 'marks a radio in oxide', () => {
		expect(
			winning(
				inField( '<input id="probe" type="radio">' ),
				'accent-color'
			)
		).toBe( OXIDE );
	} );

	it.each( [ false, true ] )(
		'edges an InputControl backdrop in oxide, focused %s',
		( focused ) => {
			const backdrop = inField(
				`<div class="components-input-control__container${
					focused ? ' is-focus-within' : ''
				}"><input class="components-input-control__input">` +
					'<div id="probe" class="components-input-control__backdrop">' +
					'</div></div>'
			);
			expect(
				winning( backdrop, 'border-top-color', [
					focused ? focusWithin : stylesheet,
				] )
			).toBe( OXIDE );
		}
	);

	it.each( [
		[ 'BaseControl label', 'label class="components-base-control__label"' ],
		[
			'InputControl label',
			'label class="components-input-control__label"',
		],
		[ 'plain label', 'label' ],
	] )( 'inks its %s in oxide', ( label, open ) => {
		const tag = open.split( ' ' )[ 0 ];
		expect(
			winning(
				inField( `<${ open } id="probe">Kea</${ tag }>` ),
				'color'
			)
		).toBe( OXIDE_TEXT );
		// A settings table's row inks its labels too.
		expect(
			winning(
				under(
					'<table class="form-table"><tr><td class="newspack-nodes-field-invalid">' +
						`<${ open } id="probe">Kea</${ tag }></td></tr></table>`
				),
				'color'
			)
		).toBe( OXIDE_TEXT );
	} );

	// The modal inks its labels past Emotion; a refused field still shows.
	it.each( [
		[
			'inside the UI root',
			( field ) =>
				'<div class="newspack-nodes-theme newspack-nodes-ui">' +
				`<div class="newspack-nodes-modal">${ field }</div></div>`,
		],
		[
			'that is the UI root',
			( field ) =>
				'<div class="newspack-nodes-theme newspack-nodes-ui ' +
				`newspack-nodes-modal">${ field }</div>`,
		],
	] )( 'inks a label in oxide in a modal %s', ( label, wrap ) => {
		const field = ( mark ) =>
			`<div class="${ mark }"><label id="probe" ` +
			'class="components-base-control__label">Kea</label></div>';
		document.body.innerHTML = wrap( field( '' ) );
		expect( winning( document.getElementById( 'probe' ), 'color' ) ).toBe(
			'#1e1e1e'
		);
		document.body.innerHTML = wrap(
			field( 'newspack-nodes-field-invalid' )
		);
		expect( winning( document.getElementById( 'probe' ), 'color' ) ).toBe(
			OXIDE_TEXT
		);
	} );
} );

describe( 'a colour or file input in the field frame', () => {
	// The declarations on `<pseudo>` of a rule whose base matches the element.
	const pseudoDecls = ( element, pseudo ) => {
		const found = {};
		stylesheet.walkRules( ( rule ) => {
			for ( const sel of topLevel( rule.selector ) ) {
				const [ base, tail ] = sel.split( '::' );
				if ( tail === pseudo && matchesButton( base, element ) ) {
					rule.walkDecls( ( d ) => ( found[ d.prop ] = d.value ) );
				}
			}
		} );
		return found;
	};

	it( 'fills a colour field with its swatch, edge to edge', () => {
		const color = under( '<input id="probe" type="color">' );
		expect( winning( color, 'inline-size' ) ).toBe( '44px' );
		expect( pseudoDecls( color, '-webkit-color-swatch-wrapper' ) ).toEqual(
			{ padding: '0' }
		);
		expect( pseudoDecls( color, '-webkit-color-swatch' ) ).toEqual( {
			border: '0',
		} );
		expect( pseudoDecls( color, '-moz-color-swatch' ) ).toEqual( {
			border: '0',
		} );
	} );

	it( 'sizes a file field to a text field, its button inside the frame', () => {
		const file = under( '<input id="probe" type="file">' );
		expect( winning( file, 'padding-top' ) ).toBe( '4px' );
		expect( winning( file, 'padding-bottom' ) ).toBe( '4px' );
		expect( winning( file, 'border-top-color' ) ).toBe( FIELD_BORDER );
	} );
} );

// Each assertion above reads every shorthand and alias, so a regression
// written in one of them reaches it: here each is planted on top.
describe( 'the cascade reader', () => {
	// A rule on the probe's id outweighs every rule the sheet holds.
	const plant = ( css ) => [ stylesheet, postcss.parse( css ) ];

	it( 'reads a chevron a background shorthand paints on a listbox', () => {
		const listbox = under( '<select id="probe" multiple></select>' );
		expect(
			winning(
				listbox,
				'background-image',
				plant( `#probe { background: #fff url(c.svg) no-repeat; }` )
			)
		).toBe( 'url(c.svg)' );
		expect(
			winning(
				listbox,
				'padding-right',
				plant( `#probe { padding-inline: 4px 22px; }` )
			)
		).toBe( '22px' );
	} );

	it( 'reads a swatch width set through the physical alias', () => {
		expect(
			winning(
				under( '<input id="probe" type="color">' ),
				'inline-size',
				plant( `#probe { width: 20px; }` )
			)
		).toBe( '20px' );
	} );

	it( 'reads a file field padding set through either shorthand', () => {
		const file = under( '<input id="probe" type="file">' );
		expect(
			winning(
				file,
				'padding-top',
				plant( `#probe { padding: 9px 3px 7px; }` )
			)
		).toBe( '9px' );
		expect(
			winning(
				file,
				'padding-bottom',
				plant( `#probe { padding-block: 2px 7px; }` )
			)
		).toBe( '7px' );
	} );

	it( 'reads an invalid edge a border shorthand repaints', () => {
		const field = under(
			'<input id="probe" type="text" aria-invalid="true">'
		);
		expect(
			winning(
				field,
				'border-top-color',
				plant( `#probe { border: 1px solid var(--rose, red); }` )
			)
		).toBe( 'red' );
		expect(
			winning(
				field,
				'border-top-color',
				plant( `#probe { border: 0; }` )
			)
		).toBe( 'currentcolor' );
	} );

	it( 'reads appearance set through its prefixed alias', () => {
		expect(
			winning(
				under( '<select id="probe" multiple></select>' ),
				'appearance',
				plant( `#probe { -webkit-appearance: none; }` )
			)
		).toBe( 'none' );
	} );
} );
