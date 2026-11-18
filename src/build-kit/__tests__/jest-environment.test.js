/* eslint-env jest */
/**
 * The jsdom environment every consumer runs on drops jsdom's report of a
 * `@wordpress/ui` stylesheet it cannot parse, and only that: any other
 * sheet jsdom cannot parse still reaches `console.error`.
 */

const WP_UI_SHEET =
	'@layer wp-ui-utilities, wp-ui-components, wp-ui-compositions, wp-ui-overrides;' +
	'@layer wp-ui-components{._a1b2__kestrel{color:teal;&:hover{color:navy}}}';

/**
 * Attach a stylesheet to the document head, as a package does on import.
 *
 * @param {string} css The sheet's text.
 */
const attach = ( css ) => {
	const style = document.createElement( 'style' );
	style.appendChild( document.createTextNode( css ) );
	document.head.appendChild( style );
};

let error;

beforeEach( () => {
	error = jest.spyOn( console, 'error' ).mockImplementation( () => {} );
} );

afterEach( () => {
	document.head.innerHTML = '';
} );

test( 'a @wordpress/ui stylesheet jsdom cannot parse reports nothing', () => {
	attach( WP_UI_SHEET );

	expect( error ).not.toHaveBeenCalled();
} );

test( 'a @wordpress/ui stylesheet opening on one layer reports nothing', () => {
	attach(
		'@layer wp-ui-utilities{._c3d4__osprey{--wp-ui-osprey-reach:7px;@media not (prefers-reduced-motion){transition:none}}}'
	);

	expect( error ).not.toHaveBeenCalled();
} );

test( 'any other stylesheet jsdom cannot parse still reports', () => {
	attach( '.heron-bureau{&:hover{color:navy}}' );

	expect( error ).toHaveBeenCalledTimes( 1 );
	const [ reported ] = error.mock.calls[ 0 ];
	expect( reported.message ).toBe( 'Could not parse CSS stylesheet' );
	expect( reported.detail ).toBe( '.heron-bureau{&:hover{color:navy}}' );
} );
