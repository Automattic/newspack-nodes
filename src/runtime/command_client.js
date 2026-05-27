import {
	newMessage,
	pack,
	unpack,
	TYPE,
	TO,
	KEY,
	VALUE,
	TM_COMMAND,
} from './message';

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
		// The body is JSONL (a verb may emit a stderr/log line AND its response);
		// the verb response is emitted last, so return the final message. Callers
		// (dashboards, unwrapCommandResponse) want the single response Message.
		const msgs = await this.#post( pack( this.buildMessage( params ) ) );
		return msgs.length ? msgs[ msgs.length - 1 ] : null;
	}

	/**
	 * POST a batch as JSONL (one packed Message per line, routed in order).
	 *
	 * @param {Array<Array>} messages Positional Messages, in dispatch order.
	 * @return {Promise<Array<Array>>} Every reply Message in the JSONL body (each
	 *   routed onward by the caller); empty when the command was routed onward (202).
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
		// JSONL: zero or more packed Messages, one per line (a routed-onward command
		// gets a bare 202 with no body). Split + unpack each — NEVER JSON.parse the
		// whole body, since a command can emit multiple messages (stderr/log + reply).
		const text = await r.text();
		return text
			? text
					.split( '\n' )
					.filter( ( line ) => '' !== line.trim() )
					.map( ( line ) => unpack( line ) )
			: [];
	}
}
