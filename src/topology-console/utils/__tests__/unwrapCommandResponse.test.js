/**
 * Asserts the topology-console re-export is the same function as the canonical helper.
 */

import canonical from '@newspack-nodes/shared/utils/unwrapCommandResponse';

import unwrapCommandResponse from '../unwrapCommandResponse';

describe( 'topology-console unwrapCommandResponse re-export', () => {
	it( 'is the canonical shared implementation, not a copy', () => {
		expect( unwrapCommandResponse ).toBe( canonical );
	} );
} );
