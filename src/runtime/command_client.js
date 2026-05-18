import { TM_COMMAND } from './message';

export class CommandClient {
	constructor( { baseUrl, nonce } ) {
		this.baseUrl = baseUrl;
		this.nonce = nonce;
	}

	/**
	 * Send a TM_COMMAND.
	 *
	 * FROM convention:
	 *   - ssePid omitted → FROM=`_http`. Local commands; the WP /command
	 *     process's HTTP_Out writes the response to the HTTP body which we
	 *     return.
	 *   - ssePid set → FROM=`_http/<ssePid>`. Pivoted IPC commands; the
	 *     worker's reply walks the FROM trail back to that SSE process,
	 *     whose HTTP_Filter Node forwards only messages addressed to its
	 *     own PID (no cross-session leak).
	 *
	 * VALUE is the substrate's wire format: JSON({name, arguments, payload}).
	 * Tachikoma contract: `arguments` is a literal CLI-shaped string (the
	 * tail after Shell peels off the verb name); `payload` is for structured
	 * data when a verb genuinely needs more than a positional argument line.
	 * Callers pick whichever fits their verb's grammar.
	 *
	 * @param {Object}      params           Send parameters.
	 * @param {string}      params.to        Target node path.
	 * @param {string}      params.verb      Command verb to dispatch.
	 * @param {string}      [params.args]    Literal-string argument tail, default ''.
	 * @param {*}           [params.payload] Optional structured data, default null.
	 * @param {number|null} [params.ssePid]  If set, pivots the reply through this SSE pid.
	 * @param {string}      [params.key]     Optional Message KEY field.
	 * @return {Promise<Array>} Parsed response Message array.
	 */
	async send( {
		to,
		verb,
		args = '',
		payload = null,
		ssePid = null,
		key = '',
	} ) {
		const from = ssePid !== null ? `_http/${ ssePid }` : '_http';
		const value = JSON.stringify( {
			name: verb,
			arguments: args,
			payload,
		} );
		const body = JSON.stringify( {
			type: TM_COMMAND,
			to,
			from,
			key,
			value,
		} );
		const r = await fetch( `${ this.baseUrl }newspack-nodes/v1/command`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-WP-Nonce': this.nonce,
			},
			body,
		} );
		return r.json();
	}
}
