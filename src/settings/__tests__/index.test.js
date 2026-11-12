import { THEME_STORAGE_KEY } from '@newspack-nodes/shared/theme';

describe( 'settings entrypoint', () => {
	afterEach( () => {
		document.body.innerHTML = '';
		document.body.removeAttribute( 'style' );
		document.documentElement.className = '';
		window.localStorage.clear();
		jest.resetModules();
	} );

	it( 'paints the gutters from the printed wrap, adding nothing to the page', () => {
		window.localStorage.setItem( THEME_STORAGE_KEY, 'synthwave' );
		document.body.innerHTML =
			'<div class="wrap newspack-nodes-settings-wrap newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui"><h1>Nodes Runtime Settings</h1></div>';
		const wrap = document.querySelector( '.newspack-nodes-settings-wrap' );
		const real = window.getComputedStyle.bind( window );
		const spy = jest
			.spyOn( window, 'getComputedStyle' )
			.mockImplementation( ( el, pseudo ) =>
				el?.tagName === 'SPAN' && el.parentNode === wrap
					? {
							backgroundColor: 'rgb(26, 11, 46)',
							getPropertyValue: () => '',
					  }
					: real( el, pseudo )
			);

		jest.isolateModules( () => {
			require( '../index' );
		} );

		expect(
			document.documentElement.classList.contains( 'theme-synthwave' )
		).toBe( true );
		expect( document.body.style.background ).toBe( 'rgb(26, 11, 46)' );
		expect( wrap.innerHTML ).toBe( '<h1>Nodes Runtime Settings</h1>' );
		spy.mockRestore();
	} );

	it( 'does nothing on a page without the settings wrap', () => {
		jest.isolateModules( () => {
			require( '../index' );
		} );
		expect( document.body.style.background ).toBe( '' );
	} );
} );

describe( 'settings bundle dependencies', () => {
	it( 'reaches no WordPress script, so its manifest names none', () => {
		const fs = require( 'fs' );
		const path = require( 'path' );
		const SRC = path.resolve( __dirname, '../..' );
		const external = [];
		const seen = new Set();
		const visit = ( file ) => {
			if ( seen.has( file ) ) {
				return;
			}
			seen.add( file );
			const source = fs.readFileSync( file, 'utf8' );
			for ( const [ , spec ] of source.matchAll(
				/(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/g
			) ) {
				let target;
				if ( spec.startsWith( '@newspack-nodes/shared/' ) ) {
					target = path.join( SRC, 'shared', spec.slice( 23 ) );
				} else if ( spec.startsWith( '.' ) ) {
					target = path.resolve( path.dirname( file ), spec );
				} else {
					external.push( spec );
					continue;
				}
				visit( target.endsWith( '.js' ) ? target : `${ target }.js` );
			}
		};
		visit( path.join( SRC, 'settings/index.js' ) );
		expect( external ).toEqual( [] );
	} );
} );
