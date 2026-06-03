import { dispatchLocalCommand } from '../dispatchLocalCommand';

const make = () => ( {
	append: jest.fn(),
	clear: jest.fn(),
	debugLevelRef: { current: 0 },
} );

describe( 'dispatchLocalCommand', () => {
	it( 'clear: calls clear() and returns true', () => {
		const { append, clear, debugLevelRef } = make();
		const handled = dispatchLocalCommand( {
			parsed: { kind: 'local', name: 'clear' },
			append,
			clear,
			debugLevelRef,
		} );
		expect( handled ).toBe( true );
		expect( clear ).toHaveBeenCalledTimes( 1 );
		expect( append ).not.toHaveBeenCalled();
	} );

	it( 'echo: appends a recv entry with the text and returns true', () => {
		const { append, clear, debugLevelRef } = make();
		const handled = dispatchLocalCommand( {
			parsed: { kind: 'local', name: 'echo', text: 'hi there' },
			append,
			clear,
			debugLevelRef,
		} );
		expect( handled ).toBe( true );
		expect( append ).toHaveBeenCalledWith( {
			kind: 'recv',
			text: 'hi there',
		} );
		expect( clear ).not.toHaveBeenCalled();
	} );

	it( 'status: appends one recv entry per line and returns true', () => {
		const { append, clear, debugLevelRef } = make();
		const handled = dispatchLocalCommand( {
			parsed: { kind: 'local', name: 'status', lines: [ 'a', 'b' ] },
			append,
			clear,
			debugLevelRef,
		} );
		expect( handled ).toBe( true );
		expect( append ).toHaveBeenNthCalledWith( 1, {
			kind: 'recv',
			text: 'a',
		} );
		expect( append ).toHaveBeenNthCalledWith( 2, {
			kind: 'recv',
			text: 'b',
		} );
	} );

	it( 'debug_level null toggles 0→1', () => {
		const { append, clear, debugLevelRef } = make();
		debugLevelRef.current = 0;
		const handled = dispatchLocalCommand( {
			parsed: { kind: 'local', name: 'debug_level', level: null },
			append,
			clear,
			debugLevelRef,
		} );
		expect( handled ).toBe( true );
		expect( debugLevelRef.current ).toBe( 1 );
		expect( append ).toHaveBeenCalledWith( {
			kind: 'info',
			text: 'debug_level: 1',
		} );
	} );

	it( 'debug_level null toggles 1→0', () => {
		const { append, clear, debugLevelRef } = make();
		debugLevelRef.current = 1;
		dispatchLocalCommand( {
			parsed: { kind: 'local', name: 'debug_level', level: null },
			append,
			clear,
			debugLevelRef,
		} );
		expect( debugLevelRef.current ).toBe( 0 );
	} );

	it( 'debug_level numeric clamps above 2 down to 2', () => {
		const { append, clear, debugLevelRef } = make();
		dispatchLocalCommand( {
			parsed: { kind: 'local', name: 'debug_level', level: 5 },
			append,
			clear,
			debugLevelRef,
		} );
		expect( debugLevelRef.current ).toBe( 2 );
		expect( append ).toHaveBeenCalledWith( {
			kind: 'info',
			text: 'debug_level: 2',
		} );
	} );

	it( 'debug_level numeric clamps below 0 up to 0', () => {
		const { append, clear, debugLevelRef } = make();
		debugLevelRef.current = 1;
		dispatchLocalCommand( {
			parsed: { kind: 'local', name: 'debug_level', level: -3 },
			append,
			clear,
			debugLevelRef,
		} );
		expect( debugLevelRef.current ).toBe( 0 );
	} );

	it( 'show_parse on: appends an info entry and returns true', () => {
		const { append, clear, debugLevelRef } = make();
		const handled = dispatchLocalCommand( {
			parsed: { kind: 'local', name: 'show_parse', on: true },
			append,
			clear,
			debugLevelRef,
		} );
		expect( handled ).toBe( true );
		expect( append ).toHaveBeenCalledWith( {
			kind: 'info',
			text: 'show_parse: on',
		} );
	} );

	it( 'show_parse off: appends off info entry', () => {
		const { append, clear, debugLevelRef } = make();
		dispatchLocalCommand( {
			parsed: { kind: 'local', name: 'show_parse', on: false },
			append,
			clear,
			debugLevelRef,
		} );
		expect( append ).toHaveBeenCalledWith( {
			kind: 'info',
			text: 'show_parse: off',
		} );
	} );

	it( 'returns false and does nothing for a non-local parse', () => {
		const { append, clear, debugLevelRef } = make();
		const handled = dispatchLocalCommand( {
			parsed: { kind: 'error', text: 'boom' },
			append,
			clear,
			debugLevelRef,
		} );
		expect( handled ).toBe( false );
		expect( append ).not.toHaveBeenCalled();
		expect( clear ).not.toHaveBeenCalled();
	} );

	it( 'unknown local name returns true without effects', () => {
		const { append, clear, debugLevelRef } = make();
		const handled = dispatchLocalCommand( {
			parsed: { kind: 'local', name: 'bogus' },
			append,
			clear,
			debugLevelRef,
		} );
		expect( handled ).toBe( true );
		expect( append ).not.toHaveBeenCalled();
		expect( clear ).not.toHaveBeenCalled();
	} );
} );
