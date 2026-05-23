import { newMessage, pack, TYPE, TO, KEY, VALUE, TM_COMMAND } from './message';

// JSONL body, so NOT application/json (see #post for why).
const COMMAND_CONTENT_TYPE = 'text/plain; charset=UTF-8';

export class CommandClient {
	constructor( { baseUrl, nonce } ) {
		this.baseUrl = baseUrl;
		this.nonce = nonce;
	}

	/**
	 * Build a TM_COMMAND as a 7-element positional Message array. FROM is left
	 * empty: the server's HTTP_In stamps the `_http` boundary onto every incoming
	 * message, and the per-session reply pivot is applied by the `_sse` node — the
	 * client never hardcodes the `_http` prefix.
	 *
	 * @param {Object} params
	 * @param {string} params.to        Target node path.
	 * @param {string} params.verb      Command verb to dispatch.
	 * @param {string} [params.args]    Literal-string argument tail, default ''.
	 * @param {*}      [params.payload] Optional structured data, default null.
	 * @param {string} [params.key]     Optional Message KEY field.
	 * @return {Array} A 7-element positional Message.
	 */
	buildMessage( { to, verb, args = '', payload = null, key = '' } ) {
		const msg = newMessage();
		msg[ TYPE ] = TM_COMMAND;
		msg[ TO ] = to;
		msg[ KEY ] = key;
		msg[ VALUE ] = {
			name: verb,
			arguments: args,
			payload,
		};
		return msg;
	}

	/**
	 * Send a single TM_COMMAND (local sync reply; 202 ack when pivoted).
	 *
	 * @param {Object} params See buildMessage().
	 * @return {Promise<Array>} Parsed response.
	 */
	async send( params ) {
		return this.#post( pack( this.buildMessage( params ) ) );
	}

	/**
	 * POST a batch as JSONL (one packed Message per line, routed in order).
	 *
	 * @param {Array<Array>} messages Positional Messages, in dispatch order.
	 * @return {Promise<Array>} Parsed response (202 ack keyed off the last).
	 */
	async postBatch( messages ) {
		return this.#post( messages.map( ( m ) => pack( m ) ).join( '\n' ) );
	}

	async #post( body ) {
		const r = await fetch( `${ this.baseUrl }newspack-nodes/v1/command`, {
			method: 'POST',
			headers: {
				// Non-JSON type so WP's REST dispatcher doesn't reject the
				// JSONL newlines with rest_invalid_json before our handler runs.
				'Content-Type': COMMAND_CONTENT_TYPE,
				'X-WP-Nonce': this.nonce,
			},
			body,
		} );
		// A synchronous reply is a packed Message (JSON); a routed-onward command
		// gets a bare 202 with no body → resolve to null (don't reject the promise).
		const text = await r.text();
		return text ? JSON.parse( text ) : null;
	}
}
