/**
 * SessionSink — the in-browser graph node the SseConnector fills, owning the
 * shared REPL transcript. Routes by KEY: gui:auto → metadata, gui:uptime →
 * uptime, everything else → transcript. Every publish emits a fresh array.
 */

import { Node } from '../../runtime/node';
import {
	TYPE,
	TIMESTAMP,
	FROM,
	TO,
	ID,
	KEY,
	VALUE,
} from '../../runtime/message';
import { parseMetadata } from '../utils/parseMetadata';
import {
	dumperRender,
	buildDebugHeader1,
	buildDebugHeader2,
} from '../utils/dumperRender';

// Transcript ring-buffer depth. Mirrors the old TopologyConsole constant.
export const TRANSCRIPT_MAX = 200;

export class SessionSink extends Node {
	/**
	 * @param {Object} params
	 * @param {Object} params.debugLevelRef Ref holding the Dumper dial (0/1/2).
	 */
	constructor( { debugLevelRef } ) {
		super();
		this.debugLevelRef = debugLevelRef || { current: 0 };
		this._transcript = [];
		// Pre-declare the events React subscribes to via useNodeState.
		this.registrations.metadata = {};
		this.registrations.uptime = {};
		this.registrations.transcript = {};
	}

	/**
	 * Process one incoming SSE msg (synchronous so bursts aren't coalesced).
	 *
	 * @param {Array|Object} raw Positional Message array or object form.
	 */
	fill( raw ) {
		this.counter += 1;
		// Normalize the positional array to the object shape the rest uses.
		const msg = Array.isArray( raw )
			? {
					type: raw[ TYPE ],
					ts: raw[ TIMESTAMP ],
					from: raw[ FROM ],
					to: raw[ TO ],
					id: raw[ ID ],
					key: raw[ KEY ],
					value: raw[ VALUE ],
			  }
			: raw;
		const value = msg.value;
		let text = null;
		if ( 'string' === typeof value ) {
			text = value;
		} else if (
			value &&
			'object' === typeof value &&
			'string' === typeof value.payload
		) {
			text = value.payload;
		}

		if ( 'gui:uptime' === msg.key ) {
			// `09:44:52  up 0 days, 00:01:00\n` → keep the right half.
			const match =
				'string' === typeof text ? text.match( /up\s+(.+)$/m ) : null;
			if ( match ) {
				this.setState( 'uptime', match[ 1 ].trim() );
			}
			return;
		}

		if ( 'gui:auto' !== msg.key ) {
			this._renderToTranscript( msg );
			return;
		}

		// gui:auto carries dump_metadata; prefer value.payload, fall back to
		// value or text. parseMetadata degrades malformed input to an empty graph.
		let meta = null;
		if ( value && 'object' === typeof value ) {
			meta =
				value.payload !== undefined && null !== value.payload
					? value.payload
					: value;
		} else {
			meta = text;
		}
		if ( null === meta || undefined === meta || '' === meta ) {
			return;
		}
		this.setState( 'metadata', parseMetadata( meta ) );
	}

	/**
	 * Append a caller-supplied transcript entry (REPL echo / error / info).
	 *
	 * @param {Object} entry `{ kind, text }`.
	 */
	append( entry ) {
		this._push( entry );
	}

	/**
	 * Empty the transcript (the `clear` builtin). Emits a fresh empty array.
	 */
	clear() {
		this._transcript = [];
		this.setState( 'transcript', [] );
	}

	// --- internals -------------------------------------------------------

	_renderToTranscript( msg ) {
		// debug_level 1+ injects a header so observers see every arrival.
		const level = this.debugLevelRef.current;
		if ( level >= 2 ) {
			// Level 2 replaces the normal render with the full envelope dump.
			this._push( { kind: 'info', text: buildDebugHeader2( msg ) } );
			return;
		}
		if ( level >= 1 ) {
			this._push( { kind: 'info', text: buildDebugHeader1( msg ) } );
		}
		const rendered = dumperRender( msg );
		if ( rendered ) {
			this._push( {
				...rendered,
				text: rendered.text.replace( /\n+$/, '' ),
			} );
		}
	}

	_push( entry ) {
		const next = this._transcript.concat( {
			...entry,
			key: `${ Date.now() }-${ Math.random()
				.toString( 36 )
				.slice( 2, 7 ) }`,
		} );
		this._transcript =
			next.length > TRANSCRIPT_MAX
				? next.slice( next.length - TRANSCRIPT_MAX )
				: next;
		this.setState( 'transcript', this._transcript );
	}
}
