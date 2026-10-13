/**
 * FetchEventSource — the stream `SseInNode` opens.
 */

/**
 * A server-sent-events stream read through `fetch()`, with `EventSource`'s
 * surface: `addEventListener()`, `close()` and a `readyState` of the same
 * three values. An `EventSource` parses its stream a character at a time,
 * which Firefox does on the main thread under a lock per character, so a
 * stream of megabyte raw blocks stalls the page; this one splits each chunk
 * with native string search. A listener may return a promise, and nothing
 * more is read until it settles, so a listener that yields to the page keeps
 * its events in order, and a body read no faster than its events are handled
 * backs the server off through TCP, which no `EventSource` can.
 *
 * It reconnects nothing itself. A stream that ends or breaks reads as
 * CONNECTING and fires `error`, and a refused one as CLOSED, as an
 * `EventSource` does, so its owner's recovery reads them alike. Only the
 * `event` and `data` fields are read: `SSE_Out_Node` sends its reopen
 * schedule as an event, and no `id:`.
 */
export class FetchEventSource {
	static CONNECTING = 0;

	static OPEN = 1;

	static CLOSED = 2;

	/**
	 * Open the stream at once, as `new EventSource()` does.
	 *
	 * @param {string}                     url       The stream's URL.
	 * @param {{withCredentials?:boolean}} [options] As `EventSource`'s: whether to send credentials to another origin.
	 */
	constructor( url, { withCredentials = false } = {} ) {
		this.url = url;
		this.readyState = FetchEventSource.CONNECTING;
		/** @type {Object<string,Array<(e: {type:string,data:string}) => void>>} */
		this._listeners = {};
		this._abort = new AbortController();
		this._read( withCredentials );
	}

	/**
	 * Listen for a named event, or `error`.
	 *
	 * @param {string}                                 type The event name.
	 * @param {(e: {type:string,data:string}) => void} cb   Its listener.
	 */
	addEventListener( type, cb ) {
		( this._listeners[ type ] ||= [] ).push( cb );
	}

	/** Stop reading; nothing is delivered after. */
	close() {
		this.readyState = FetchEventSource.CLOSED;
		this._abort.abort();
	}

	/**
	 * Fetch the stream and parse its frames until it ends, is refused, or is
	 * closed.
	 *
	 * @param {boolean} withCredentials Send credentials to another origin.
	 */
	async _read( withCredentials ) {
		let refused = false;
		try {
			const response = await fetch( this.url, {
				headers: { Accept: 'text/event-stream' },
				credentials: withCredentials ? 'include' : 'same-origin',
				cache: 'no-store',
				signal: this._abort.signal,
			} );
			const type = response.headers.get( 'content-type' ) ?? '';
			refused = ! response.ok || ! type.startsWith( 'text/event-stream' );
			if ( ! refused ) {
				this.readyState = FetchEventSource.OPEN;
				await this._parse( response.body.getReader() );
			}
		} catch ( e ) {
			// Anything that breaks the stream reads as its end.
		}
		this._end(
			refused ? FetchEventSource.CLOSED : FetchEventSource.CONNECTING
		);
	}

	/**
	 * Settle the stream's end: a state, then one `error`, unless `close()`
	 * already ended it.
	 *
	 * @param {number} state CONNECTING for an ended or broken stream, CLOSED for a refused one.
	 */
	_end( state ) {
		if ( FetchEventSource.CLOSED === this.readyState ) {
			return;
		}
		this.readyState = state;
		this._emit( 'error', '' );
	}

	/**
	 * Read the body's chunks, dispatching each event as its blank line ends
	 * it. The search for a line's end resumes where the last one stopped, so
	 * a megabyte line arriving in many chunks is scanned once.
	 *
	 * @param {ReadableStreamDefaultReader} reader The body's reader.
	 */
	async _parse( reader ) {
		const decoder = new TextDecoder();
		let buffer = '';
		let from = 0;
		let event = '';
		let data = [];
		for (;;) {
			const { done, value } = await reader.read();
			if ( done || FetchEventSource.CLOSED === this.readyState ) {
				return;
			}
			buffer += decoder.decode( value, { stream: true } );
			let start = 0;
			let nl;
			while ( -1 !== ( nl = buffer.indexOf( '\n', from ) ) ) {
				const end =
					nl > start && '\r' === buffer[ nl - 1 ] ? nl - 1 : nl;
				const line = buffer.slice( start, end );
				start = nl + 1;
				from = start;
				if ( '' === line ) {
					if ( data.length ) {
						await this._emit(
							event || 'message',
							data.join( '\n' )
						);
					}
					event = '';
					data = [];
					continue;
				}
				const colon = line.indexOf( ':' );
				const field = -1 === colon ? line : line.slice( 0, colon );
				const fieldValue =
					-1 === colon
						? ''
						: line.slice(
								' ' === line[ colon + 1 ]
									? colon + 2
									: colon + 1
						  );
				if ( 'event' === field ) {
					event = fieldValue;
				} else if ( 'data' === field ) {
					data.push( fieldValue );
				}
			}
			buffer = buffer.slice( start );
			from = buffer.length;
		}
	}

	/**
	 * Hand one event to its listeners, waiting on any that returns a promise.
	 *
	 * @param {string} type The event name.
	 * @param {string} data Its data.
	 */
	async _emit( type, data ) {
		for ( const cb of this._listeners[ type ] ?? [] ) {
			if (
				FetchEventSource.CLOSED === this.readyState &&
				'error' !== type
			) {
				return;
			}
			await cb( { type, data } );
		}
	}
}
