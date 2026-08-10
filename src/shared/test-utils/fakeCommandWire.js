/**
 * makeFakeCommandWire — a `global.fetch` double for the `/command` endpoint.
 *
 * The seam is the wire, not the client: a graph under test packs its batch,
 * POSTs it, and gets JSONL back, so pack/unpack, HttpOut, the router and the
 * interpreter all run for real. Replies come back the way the server sends
 * them — `TO = FROM`, addressed at the node that minted the command — which is
 * the routing the hooks under test depend on.
 *
 *   global.fetch = makeFakeCommandWire( ( m ) =>
 *       'list' === m[ VALUE ].name ? { topologies: [] } : null
 *   );
 *
 * `replyFor` returns the reply payload, an `Error` to answer TM_ERROR, or
 * `undefined` for a command the server routes onward without replying.
 */

/* eslint-env jest */
import {
	ensureSession,
	__setAuthFetch,
	newMessage,
	pack,
	unpack,
	TYPE,
	FROM,
	TO,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
} from '@newspack-nodes/runtime';

/**
 * Answer a batch of command Messages the way the server would.
 *
 * Shared with `makeFakeCommandWire` so a test that captures at the HttpOut
 * client seam produces the same replies as one that captures at the wire.
 *
 * @param {Array<Array>} messages Posted command Messages.
 * @param {Function}     replyFor Maps one to its reply payload.
 * @return {Promise<Array<Array>>} Reply Messages, addressed TO = FROM.
 */
export async function answerBatch( messages, replyFor ) {
	const replies = [];
	for ( const sent of messages ) {
		// Awaited, so a replyFor that resolves a payload works unchanged.
		const answer = await replyFor( sent );
		// undefined = the server said nothing; a 202-style routed command.
		if ( undefined === answer ) {
			continue;
		}
		const reply = newMessage();
		const failed = answer instanceof Error;
		reply[ TYPE ] = TM_COMMAND | ( failed ? TM_ERROR : TM_RESPONSE );
		reply[ TO ] = sent[ FROM ];
		reply[ VALUE ] = {
			name: sent[ VALUE ]?.name,
			payload: failed ? answer.message : answer,
		};
		replies.push( reply );
	}
	return replies;
}

/**
 * The slice of `fetch` a graph under test reaches for: the response is read
 * back with `text()`, never as a whole `Response`.
 *
 * @typedef {( url?: any, init?: { body?: any } ) => Promise<{ ok: boolean, status: number, text: () => Promise<string> }>} FakeFetch
 */

/**
 * The wire plus what was POSTED, unpacked — the client double offered this by
 * letting a caller push in `postBatch`, and every converting suite needs it.
 *
 * @typedef {FakeFetch & { batches: Array<Array<Array>> }} RecordingFakeFetch
 */

/**
 * @param {( message: Array ) => any} replyFor Maps a posted command Message to
 *                                             its reply payload — a value, an
 *                                             `Error`, `undefined`, or a
 *                                             promise of any of those.
 * @return {RecordingFakeFetch} A `fetch` double answering `/command`.
 */
export function makeFakeCommandWire( replyFor ) {
	const wire = /** @type {RecordingFakeFetch} */ (
		/** @type {unknown} */ (
			jest.fn( async ( url, init ) => {
				const sent = String( init?.body ?? '' )
					.split( '\n' )
					.filter( ( line ) => '' !== line.trim() )
					.map( ( line ) => unpack( line ) );
				wire.batches.push( sent );
				const replies = await answerBatch( sent, replyFor );
				return {
					ok: true,
					status: 200,
					text: () =>
						Promise.resolve(
							replies.map( ( m ) => pack( m ) ).join( '\n' )
						),
				};
			} )
		)
	);
	wire.batches = [];
	return wire;
}

/**
 * Install the wire AND a session, so the graph signs and mints for real.
 *
 * Without a session `Node.command()` returns null and every mint is refused —
 * which in a test reads as a mysterious "not authenticated" rather than as the
 * missing /auth stub it is.
 *
 * @param {( message: Array ) => any} replyFor Maps a posted command Message to
 *                                             its reply payload.
 * @return {typeof fetch} The installed `global.fetch`.
 */
export function installFakeCommandWire( replyFor ) {
	__setAuthFetch( async () => ( {
		handle: 'test-handle',
		key: 'test-key',
		expires_in: 3600,
	} ) );
	// @longform
	// Kicked, not forgotten: the session is module state that outlives a
	// test, and dropping it would make the first mint of every test race
	// /auth. Callers that WANT the pre-auth state call forgetSession().
	void ensureSession();
	// The double covers only the read slice; widen it to the fetch slot.
	global.fetch = /** @type {typeof fetch} */ (
		/** @type {unknown} */ ( makeFakeCommandWire( replyFor ) )
	);
	return global.fetch;
}
