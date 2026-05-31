import { lockPageScroll, unlockPageScroll } from '../pageScrollLock';

describe( 'pageScrollLock', () => {
	const html = () => document.documentElement;
	const body = () => document.body;

	afterEach( () => {
		unlockPageScroll();
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

	it( 'unlock is a no-op when not locked', () => {
		html().style.overflow = 'visible';
		unlockPageScroll();
		expect( html().style.overflow ).toBe( 'visible' );
	} );
} );
