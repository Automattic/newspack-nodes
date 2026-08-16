/**
 * Jest globals used by setup modules that legitimately run under jest.
 *
 * `tsconfig.check.json` sets `types: ["node"]` and `@types/jest` is not a
 * dependency, so a file jest loads as a setup module — not a test — has no
 * declaration for the lifecycle hooks it calls. Declared here rather than
 * pulling in a type package: the checked sources touch a handful of these
 * names, and the test files themselves are excluded from the check.
 *
 * Narrow by design. Add a name when a checked file actually calls it; this is
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
 */
declare const jest: {
	fn< T extends ( ...args: any[] ) => any >( implementation: T ): T;
	spyOn(
		object: any,
		method: string
	): { mockImplementation( fn: ( ...args: any[] ) => any ): void };
};
