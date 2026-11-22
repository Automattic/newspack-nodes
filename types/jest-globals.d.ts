/**
 * Jest globals used by setup modules and shared test utilities that
 * legitimately run under jest.
 *
 * `tsconfig.check.json` sets `types: ["node"]` and `@types/jest` is not a
 * dependency, so a file jest loads as a setup module, or a helper a test
 * imports from `src/shared/test-utils/`, has no declaration for the jest
 * names it calls. Declared here rather than
 * pulling in a type package: the checked sources touch a handful of these
 * names, and the test files themselves are excluded from the check.
 *
 * Narrow by design. Add a name when a checked file calls it; this is
 * not a stand-in for `@types/jest`.
 */

declare function afterAll( fn: () => void ): void;
declare function afterEach( fn: () => void ): void;

/**
 * `fn` returns its implementation: enough to keep a double callable with the
 * signature it was written with, without claiming a mock-metadata surface no
 * checked file reads (the suites that call `.mockClear()` are excluded).
 *
 * `spyOn` returns the mock so a caller can chain `mockImplementation`; the
 * shared `runClockFast` helper replaces `Core.now` with it.
 *
 * The three timer calls are the ones the shared dialog-exit helpers make
 * (`answerConfirm`, `expectExitThenGone`) to play a dialog's exit.
 */
declare const jest: {
	fn< T extends ( ...args: any[] ) => any >( implementation: T ): T;
	spyOn(
		object: any,
		method: string
	): { mockImplementation( fn: ( ...args: any[] ) => any ): void };
	useFakeTimers( config?: { doNotFake?: string[] } ): void;
	advanceTimersByTime( ms: number ): void;
	useRealTimers(): void;
};

/**
 * The matchers `expectExitThenGone` asserts with, and no others.
 */
interface SharedHelperMatchers {
	toBeNull(): void;
	toContain( expected: string ): void;
	not: SharedHelperMatchers;
}

declare function expect( actual: unknown ): SharedHelperMatchers;
