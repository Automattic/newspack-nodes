/**
 * Every dashboard mounts through mountExospine, so it is the one place that can
 * guarantee a command session exists before a human can type a command.
 *
 * Signing is synchronous and reads whatever the session establishment left
 * behind, so the /auth round trip has to be started at mount rather than lazily
 * on the first command — a command minted before it resolves would ship
 * unsigned and be refused.
 */
import { mountExospine } from '../exospine';
import { forgetSession, __setAuthFetch } from '../command-auth';

describe( 'mountExospine session establishment', () => {
	afterEach( () => {
		forgetSession();
		__setAuthFetch( null );
	} );

	it( 'establishes the command session at mount', async () => {
		let asked = 0;
		forgetSession();
		__setAuthFetch( async () => {
			asked++;
			return {
				handle: 'aaaa1111bbbb2222cccc3333dddd4444',
				key: 'mount-session-key-4242',
				expires_in: 3600,
			};
		} );

		const { teardown } = mountExospine( () => {} );
		await Promise.resolve();

		expect( asked ).toBe( 1 );
		teardown();
	} );
} );
