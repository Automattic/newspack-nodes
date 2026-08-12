import {
	holdPageScroll,
	lockPageScroll,
	releasePageScroll,
	unlockPageScroll,
} from '../pageScrollLock';

describe( 'pageScrollLock', () => {
	const html = () => document.documentElement;
	const body = () => document.body;

	afterEach( () => {
		unlockPageScroll();
		releasePageScroll( 'maximize' );
		html().style.overflow = '';
		html().style.paddingRight = '';
		body().style.overflow = '';
	} );

	it( 'locks BOTH html and body overflow (Safari ignores html alone)', () => {
		lockPageScroll();
		expect( html().style.overflow ).toBe( 'hidden' );
		expect( body().style.overflow ).toBe( 'hidden' );
	} );

	it( 'restores the previous overflow on both elements on unlock', () => {
		html().style.overflow = 'auto';
		body().style.overflow = 'scroll';
		lockPageScroll();
		expect( html().style.overflow ).toBe( 'hidden' );
		expect( body().style.overflow ).toBe( 'hidden' );
		unlockPageScroll();
		expect( html().style.overflow ).toBe( 'auto' );
		expect( body().style.overflow ).toBe( 'scroll' );
	} );

	it( 'is idempotent — a second lock does not clobber the saved state', () => {
		html().style.overflow = 'visible';
		body().style.overflow = 'visible';
		lockPageScroll();
		lockPageScroll(); // no-op; must NOT re-save the already-hidden values
		unlockPageScroll();
		expect( html().style.overflow ).toBe( 'visible' );
		expect( body().style.overflow ).toBe( 'visible' );
	} );

	it( 'holds the lock until every reason has released it', () => {
		html().style.overflow = 'auto';
		body().style.overflow = 'scroll';
		lockPageScroll(); // pointer enters the panel
		holdPageScroll( 'maximize' );
		unlockPageScroll(); // pointer leaves, but the panel is maximized
		expect( html().style.overflow ).toBe( 'hidden' );
		expect( body().style.overflow ).toBe( 'hidden' );
		releasePageScroll( 'maximize' );
		expect( html().style.overflow ).toBe( 'auto' );
		expect( body().style.overflow ).toBe( 'scroll' );
	} );

	it( 'ignores a gutter measured against a bogus clientWidth', () => {
		const inner = Object.getOwnPropertyDescriptor( window, 'innerWidth' );
		Object.defineProperty( window, 'innerWidth', {
			value: 30,
			writable: true,
			configurable: true,
		} );
		try {
			// jsdom reports clientWidth 0, so the whole 30px reads as gutter.
			lockPageScroll();
			expect( html().style.paddingRight ).toBe( '' );
		} finally {
			Object.defineProperty( window, 'innerWidth', inner );
		}
	} );

	it( 'does not set a runaway paddingRight when the gutter reads bogus', () => {
		// jsdom's ~0 clientWidth makes the gutter the whole viewport; guard it.
		lockPageScroll();
		expect( html().style.paddingRight ).toBe( '' );
	} );

	it( 'is a no-op on Chromium (the panel wheel-eater already blocks scroll there, and the CSS lock reflows the page behind)', () => {
		const orig = Object.getOwnPropertyDescriptor(
			window.navigator,
			'userAgent'
		);
		Object.defineProperty( window.navigator, 'userAgent', {
			value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
			configurable: true,
		} );
		try {
			html().style.overflow = 'scroll';
			lockPageScroll();
			// Untouched: no CSS lock on Chromium.
			expect( html().style.overflow ).toBe( 'scroll' );
			expect( body().style.overflow ).toBe( '' );
		} finally {
			if ( orig ) {
				Object.defineProperty( window.navigator, 'userAgent', orig );
			}
		}
	} );

	it( 'unlock is a no-op when not locked', () => {
		html().style.overflow = 'visible';
		unlockPageScroll();
		expect( html().style.overflow ).toBe( 'visible' );
	} );
} );
