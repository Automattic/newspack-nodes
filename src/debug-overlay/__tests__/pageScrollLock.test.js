import { lockPageScroll, unlockPageScroll } from '../pageScrollLock';

describe( 'pageScrollLock', () => {
	const el = () => document.scrollingElement || document.documentElement;

	afterEach( () => {
		unlockPageScroll();
		el().style.overflow = '';
		el().style.paddingRight = '';
	} );

	it( 'locks the page scroll element to overflow:hidden', () => {
		lockPageScroll();
		expect( el().style.overflow ).toBe( 'hidden' );
	} );

	it( 'restores the previous overflow on unlock', () => {
		el().style.overflow = 'auto';
		lockPageScroll();
		expect( el().style.overflow ).toBe( 'hidden' );
		unlockPageScroll();
		expect( el().style.overflow ).toBe( 'auto' );
	} );

	it( 'is idempotent — a second lock does not clobber the saved state', () => {
		el().style.overflow = 'scroll';
		lockPageScroll();
		lockPageScroll(); // no-op; must NOT re-save the already-hidden value
		unlockPageScroll();
		expect( el().style.overflow ).toBe( 'scroll' );
	} );

	it( 'unlock is a no-op when not locked', () => {
		el().style.overflow = 'visible';
		unlockPageScroll();
		expect( el().style.overflow ).toBe( 'visible' );
	} );
} );
