import {
	newMessage,
	pack,
	TYPE,
	FROM,
	TO,
	KEY,
	VALUE,
	TM_COMMAND,
} from './message';

/**
 * Content-Type for the /command POST. The body is JSONL (one packed Message
 * per line), so it must NOT be `application/json` — see the rationale in
 * `#post`.
 */
const COMMAND_CONTENT_TYPE = 'text/plain; charset=UTF-8';

export class CommandClient {
	constructor( { baseUrl, nonce } ) {
		this.baseUrl = baseUrl;
		this.nonce = nonce;
	}

	/**
	 * Build a TM_COMMAND as a 7-element positional Message array — the wire
	 * shape the server's `Message::unpacked()` requires. `pack()` it for a
	 * single `send()`, or include it in a `postBatch()` list.
	 *
	 * FROM convention:
	 *   - ssePid omitted → FROM=`_http`. Local commands; the WP /command
	 *     process's HTTP_Out writes the response to the HTTP body.
	 *   - ssePid set → FROM=`_http/<ssePid>`. Pivoted IPC commands; the
	 *     worker's reply walks the FROM trail back to that SSE process, whose
	 *     HTTP_Filter forwards only messages addressed to its own PID.
	 *
	 * VALUE is the structured command object `{ name, arguments, payload }`
	 * itself — NOT separately JSON-encoded. It rides through the whole-message
	 * JSON envelope (`pack()` / `postBatch()`'s `JSON.stringify`) as a nested
	 * object, the only serialization layer. `arguments` is a literal CLI-shaped
	 * string (the tail after Shell peels the verb name); `payload` carries
	 * structured data when a verb needs more than a positional line. ID stays
	 * '' — responses correlate on KEY.
	 *
	 * @param {Object}      params
	 * @param {string}      params.to        Target node path.
	 * @param {string}      params.verb      Command verb to dispatch.
	 * @param {string}      [params.args]    Literal-string argument tail, default ''.
	 * @param {*}           [params.payload] Optional structured data, default null.
	 * @param {number|null} [params.ssePid]  If set, pivots the reply through this SSE pid.
	 * @param {string}      [params.key]     Optional Message KEY field.
	 * @return {Array} A 7-element positional Message.
	 */
	buildMessage( {
		to,
		verb,
		args = '',
		payload = null,
		ssePid = null,
		key = '',
	} ) {
		const msg = newMessage();
		msg[ TYPE ] = TM_COMMAND;
		msg[ FROM ] = ssePid !== null ? `_http/${ ssePid }` : '_http';
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
	 * Send a single TM_COMMAND. Returns the parsed response Message (the
	 * synchronous HTTP_Out reply for local commands; a 202 ack for pivoted
	 * ones, whose real reply arrives via the SSE stream).
	 *
	 * @param {Object} params See buildMessage().
	 * @return {Promise<Array>} Parsed response.
	 */
	async send( params ) {
		return this.#post( pack( this.buildMessage( params ) ) );
	}

	/**
	 * POST a BATCH as JSONL — one packed Message per line. The server routes
	 * each line in order through one request graph in this single process, so a
	 * leading setup command (e.g. connect_worker_input) takes effect before a
	 * following command routes. `pack()` is the only JSON boundary, applied
	 * per line — there is no array-of-messages wrapper.
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
				// The body is JSONL (one packed Message per line) — NOT a single
				// JSON document. Sending `application/json` makes WordPress's REST
				// dispatcher pre-parse the body as JSON and reject the newlines
				// with a 400 `rest_invalid_json` before our handler runs. A
				// non-JSON content type makes WP pass the raw body through to
				// Command_Controller::messages_from_body(), which splits the lines.
				'Content-Type': COMMAND_CONTENT_TYPE,
				'X-WP-Nonce': this.nonce,
			},
			body,
		} );
		return r.json();
	}
}
