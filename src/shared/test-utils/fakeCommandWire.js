/**
 * A `/command` server double for tests that drive a real browser node graph.
 *
 * The seam is the wire, not the client: a graph under test packs its batch,
 * POSTs it, and gets JSONL back, so pack/unpack, HttpOut, the Router and the
 * interpreter all run for real. Replies come back the way the server sends
 * them — `TO = FROM`, addressed at the node that minted the command — which is
 * the routing the hooks under test rely on (ADR-7).
 *
 *   installFakeCommandWire( ( m ) =>
 *       'dump' === m[ VALUE ].name ? { topologies: [] } : null
 *   );
 *
 * `replyFor` returns the reply payload, an `Error` to answer TM_ERROR, or
 * `undefined` for a command the server routes onward without replying.
 *
 * `installFakeCommandWire` stubs `/auth` as well, so the graph signs for real.
 * `makeFakeCommandWire` builds the same double and leaves the session alone,
 * for a test that packs its own signed messages.
 */

/* eslint-env jest */
import {
	ensureSession,
	asString,
	isCommandAsk,
	isCommandStruct,
	isRequestCommand,
	__setAuthFetch,
	newMessage,
	pack,
	unpack,
	TYPE,
	FROM,
	TO,
	ID,
	KEY,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	TM_NOREPLY,
} from '@newspack-nodes/runtime';

/**
 * Server behaviours a suite can switch. Setting `requireSignature` false
 * answers unsigned commands as well, which a test of the pre-auth path needs.
 *
 * @typedef {{requireSignature?: boolean}} ServerOptions
 */

/**
 * Answer a batch of command Messages the way the server would.
 *
 * Shared with `makeFakeCommandWire` so a test that captures at the HttpOut
 * client seam produces the same replies as one that captures at the wire.
 *
 * An unsigned request command is REFUSED, the way the controller's
 * `authorize_and_latch()` refuses one — a signature the minter forgot is the
 * regression this double exists to make loud (ADR-15). Only the presence of
 * `auth.sig` is checked; the double holds no key, so it verifies nothing. The
 * order is PHP's: `interpret()` drops a VALUE that is no command struct
 * (`isCommandStruct()`), signed or not, unanswered; `check()` then refuses an
 * unsigned command, or one it cannot verify at all ("wrong type", a
 * non-numeric TIMESTAMP), and `interpret()` answers it `unauthorized: <name>`
 * with PHP's one terminator, or throws and answers nothing for a TM_NOREPLY one.
 *
 * @param {Array<Array>}              messages  Posted command Messages.
 * @param {( message: Array ) => any} replyFor  Maps one to its reply payload.
 * @param {ServerOptions}             [options] Server-behaviour switches.
 * @return {Promise<Array<Array>>} Reply Messages, addressed TO = FROM.
 */
export async function answerBatch( messages, replyFor, options = {} ) {
	const { requireSignature = true } = options;
	// @longform Every command in the batch reaches the verb, and only then does
	// the POST answer. Awaiting each in turn instead means one slow command
	// hides the rest: a test holding the first reply open would see the second
	// as never sent, when the wire carried both in the same body.
	const asked = messages.map( ( sent ) => {
		const value = sent[ VALUE ];
		if ( isCommandAsk( sent ) ) {
			// interpret(): no command struct, no answer, signed or not.
			if ( ! isCommandStruct( value ) ) {
				return { sent, answer: undefined };
			}
			// check(): unverifiable or unsigned is unauthorized, never run.
			if (
				requireSignature &&
				( ! isRequestCommand( sent ) || ! value.auth?.sig )
			) {
				const noreply = 0 !== ( sent[ TYPE ] & TM_NOREPLY );
				return {
					sent,
					answer: noreply
						? undefined
						: new Error(
								`unauthorized: ${ asString( value.name ) }\n`
						  ),
				};
			}
		}
		// interpret() answers a TM_NOREPLY command with nothing, run or not.
		const answer = replyFor( sent );
		return {
			sent,
			answer: 0 !== ( sent[ TYPE ] & TM_NOREPLY ) ? undefined : answer,
		};
	} );
	const replies = [];
	for ( const { sent, answer } of asked ) {
		// Awaited, so a replyFor may return a promise for its payload.
		const settled = await answer;
		// undefined means the server said nothing and routed it onward.
		if ( undefined === settled ) {
			continue;
		}
		const failed = settled instanceof Error;
		replies.push(
			commandReply(
				sent,
				failed ? settled.message : settled,
				failed ? TM_ERROR : TM_RESPONSE
			)
		);
	}
	return replies;
}

/**
 * The server's reply envelope, as both interpreters build it: TO = FROM, with
 * ID, KEY and the request's `name` and `arguments` echoed back as PHP strings. Exported because a suite
 * that builds its own transport double must still answer like the server: a
 * reply without TO = FROM never reaches the node that minted the command, and
 * the test sees silence rather than a failure it can read.
 *
 * @param {Array}  sent    The command being answered.
 * @param {*}      payload The reply payload.
 * @param {number} [kind]  TM_RESPONSE or TM_ERROR.
 * @return {Array} The reply Message.
 */
export function commandReply( sent, payload, kind = TM_RESPONSE ) {
	const reply = newMessage();
	reply[ TYPE ] = TM_COMMAND | kind;
	reply[ FROM ] = '_command_interpreter';
	reply[ TO ] = sent[ FROM ];
	reply[ ID ] = sent[ ID ];
	reply[ KEY ] = sent[ KEY ];
	const args = sent[ VALUE ]?.arguments;
	reply[ VALUE ] = {
		name: asString( sent[ VALUE ]?.name ),
		arguments: Array.isArray( args ) ? args.map( asString ) : [],
		payload,
	};
	return reply;
}

/**
 * The slice of `fetch` a graph under test reaches for: the response is read
 * back with `text()`, never as a whole `Response`.
 *
 * @typedef {( url?: any, init?: { body?: any } ) => Promise<{ ok: boolean, status: number, text: () => Promise<string> }>} FakeFetch
 */

/**
 * The wire plus `batches`: every POST body, unpacked, in the order it was
 * sent — so a suite can assert WHAT was posted without replacing the transport.
 *
 * @typedef {FakeFetch & { batches: Array<Array<Array>> }} RecordingFakeFetch
 */

/**
 * Build the `fetch` double, recording every batch it is handed.
 *
 * @param {( message: Array ) => any} replyFor  Maps a posted command Message to
 *                                              its reply payload — a value, an
 *                                              `Error`, `undefined`, or a
 *                                              promise of any of those.
 * @param {ServerOptions}             [options] Server-behaviour switches.
 * @return {RecordingFakeFetch} A `fetch` double answering `/command`.
 */
export function makeFakeCommandWire( replyFor, options = {} ) {
	const wire = /** @type {RecordingFakeFetch} */ (
		/** @type {unknown} */ (
			jest.fn( async ( url, init ) => {
				const sent = String( init?.body ?? '' )
					.split( '\n' )
					.filter( ( line ) => '' !== line.trim() )
					.map( ( line ) => unpack( line ) );
				wire.batches.push( sent );
				const replies = await answerBatch( sent, replyFor, options );
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
 * missing /auth stub it is. The session is module state outliving one test, and
 * resetting it here would make every test's first mint race /auth, so a suite
 * that WANTS the pre-auth state calls `forgetSession()` itself.
 *
 * @param {( message: Array ) => any} replyFor  Maps a posted command Message to
 *                                              its reply payload.
 * @param {ServerOptions}             [options] Server-behaviour switches.
 * @return {typeof fetch} The installed `global.fetch`.
 */
export function installFakeCommandWire( replyFor, options = {} ) {
	__setAuthFetch( async () => ( {
		handle: 'test-handle',
		secret: 'test-secret',
		expires_in: 3600,
	} ) );
	// Kicked off here, not awaited: an unsigned mint comes back refused.
	void ensureSession();
	// The double covers only the read slice; widen it to the fetch slot.
	global.fetch = /** @type {typeof fetch} */ (
		/** @type {unknown} */ ( makeFakeCommandWire( replyFor, options ) )
	);
	return global.fetch;
}
