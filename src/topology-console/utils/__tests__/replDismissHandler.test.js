import { makeReplDismissHandler } from '../replDismissHandler';

describe( 'makeReplDismissHandler', () => {
	it( 'returns false without dismissing when replExpanded is false', () => {
		const setReplExpanded = jest.fn();
		const blur = jest.fn();
		const inputRef = { current: { blur } };
		const handler = makeReplDismissHandler( {
			replExpanded: false,
			setReplExpanded,
			inputRef,
		} );

		const result = handler();

		expect( result ).toBe( false );
		expect( setReplExpanded ).not.toHaveBeenCalled();
		expect( blur ).not.toHaveBeenCalled();
	} );

	it( 'collapses the footer, blurs the input, and returns true when expanded', () => {
		const setReplExpanded = jest.fn();
		const blur = jest.fn();
		const inputRef = { current: { blur } };
		const handler = makeReplDismissHandler( {
			replExpanded: true,
			setReplExpanded,
			inputRef,
		} );

		const result = handler();

		expect( result ).toBe( true );
		expect( setReplExpanded ).toHaveBeenCalledWith( false );
		expect( blur ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'still returns true and collapses when inputRef.current is null', () => {
		const setReplExpanded = jest.fn();
		const inputRef = { current: null };
		const handler = makeReplDismissHandler( {
			replExpanded: true,
			setReplExpanded,
			inputRef,
		} );

		expect( handler() ).toBe( true );
		expect( setReplExpanded ).toHaveBeenCalledWith( false );
	} );

	it( 'still returns true and collapses when inputRef itself is undefined', () => {
		const setReplExpanded = jest.fn();
		const handler = makeReplDismissHandler( {
			replExpanded: true,
			setReplExpanded,
			inputRef: undefined,
		} );

		expect( handler() ).toBe( true );
		expect( setReplExpanded ).toHaveBeenCalledWith( false );
	} );
} );
