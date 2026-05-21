/**
 * The topology-console copy of unwrapCommandResponse is a thin re-export of
 * the canonical implementation in `src/shared/utils/unwrapCommandResponse.js`.
 * The behavioral contract is exercised by the shared module's own test suite
 * (`src/shared/utils/__tests__/unwrapCommandResponse.test.js`); here we only
 * assert that the re-export hands back the very same function, so the two
 * import paths can never drift.
 */

import canonical from '../../../shared/utils/unwrapCommandResponse';

import unwrapCommandResponse from '../unwrapCommandResponse';

describe( 'topology-console unwrapCommandResponse re-export', () => {
	it( 'is the canonical shared implementation, not a copy', () => {
		expect( unwrapCommandResponse ).toBe( canonical );
	} );
} );
