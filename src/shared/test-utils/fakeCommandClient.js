/**
 * makeFakeCommandClient — a shared HttpOut-seam double for dashboard hook tests.
 *
 * Matches the seam HttpOut drives: `buildMessage` mints a TM_COMMAND, `postBatch`
 * resolves to replies routed back along FROM (the server's reply path) carrying
 * the correlation ID and a per-message payload from `replyFor`. Test-only helper;
 * sibling plugins consume it via the `@newspack-nodes/shared` alias, not a copy.
 */

import {
	newMessage,
	ID,
	TO,
	FROM,
	VALUE,
	TYPE,
	TM_COMMAND,
	TM_RESPONSE,
} from '@newspack-nodes/runtime';

/**
 * @param {Function} replyFor Maps a posted command Message to its reply payload.
 * @return {Object} A fake CommandClient with `buildMessage` + `postBatch`.
 */
export function makeFakeCommandClient( replyFor ) {
	return {
		buildMessage( { to, verb, args = '', payload = null } ) {
			const m = newMessage();
			m[ TYPE ] = TM_COMMAND;
			m[ TO ] = to;
			m[ VALUE ] = { name: verb, arguments: args, to, payload };
			return m;
		},
		postBatch( messages ) {
			const replies = messages.map( ( msg ) => {
				const reply = newMessage();
				reply[ TYPE ] = TM_COMMAND | TM_RESPONSE;
				reply[ TO ] = msg[ FROM ];
				reply[ ID ] = msg[ ID ];
				reply[ VALUE ] = {
					name: msg[ VALUE ]?.name,
					payload: replyFor( msg ),
				};
				return reply;
			} );
			return Promise.resolve( replies );
		},
	};
}
