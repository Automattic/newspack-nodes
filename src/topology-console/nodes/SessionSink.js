/**
 * SessionSink — the in-browser graph node the SseConnector fills each frame
 * into. It replaces TopologyConsole's procedural handleMessage and owns the
 * shared REPL transcript.
 *
 * Routing by KEY (preserving the old handleMessage semantics exactly):
 *   - 'gui:auto'  → response to a silent canvas poll; parseMetadata and
 *     publish via setState('metadata', graph). Never the transcript.
 *   - 'gui:uptime' → keep the right half of the `uptime` line and publish
 *     via setState('uptime', text). Never the transcript.
 *   - everything else (gui:typed, async broadcasts) → run through the
 *     Dumper-style renderer (with optional debug_level header injection) and
 *     append to the transcript ring buffer, publishing via
 *     setState('transcript', snapshot).
 *
 * The transcript is shared: REPL command echoes and error/info lines come
 * from TopologyConsole via append(), and the `clear` builtin via clear().
 * Both write the same buffer the incoming-message path writes, so ordering
 * is preserved. Every publish emits a FRESH array so useNodeState's
 * Object.is bail-out doesn't swallow updates.
 *
 * fill() accepts the raw positional Message array the SseConnector delivers
 * (`[TYPE,TIMESTAMP,FROM,TO,ID,KEY,VALUE]`) and normalizes it to the object
 * form `{ type, ts, from, to, id, key, value }` its routing + dumperRender use.
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
	 * @param {Object} params.debugLevelRef React ref (`{ current }`) holding the
	 *                                      Dumper verbosity dial (0/1/2). Read
	 *                                      synchronously on each fill.
	 */
	constructor( { debugLevelRef } ) {
		super();
		this.debugLevelRef = debugLevelRef || { current: 0 };
		// Mutable backing store for the transcript; published as fresh
		// snapshots via setState('transcript', …).
		this._transcript = [];
		// Pre-declare the events React subscribes to via useNodeState.
		this.registrations.metadata = {};
		this.registrations.uptime = {};
		this.registrations.transcript = {};
	}

	/**
	 * Process one incoming SSE msg (object shape). Synchronous so a burst
	 * can't be coalesced away.
	 *
	 * @param {Array|Object} raw The positional Message array
	 *                           `[TYPE,TIMESTAMP,FROM,TO,ID,KEY,VALUE]` that
	 *                           SseConnector fills, or the equivalent object
	 *                           `{ type, ts, from, to, id, key, value }`.
	 */
	fill( raw ) {
		this.counter += 1;
		// SseConnector fills the raw positional Message array; the rest of this
		// node (and dumperRender) speaks the object shape, so normalize once.
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

		// gui:auto polls only ever emit `dump_metadata`. Per the command
		// protocol contract the response VALUE rides the whole-message
		// envelope as a nested object, so `value.payload` is the metadata
		// OBJECT directly — hand it to parseMetadata (object-in). Fall back
		// to the bare `value` (when it IS the metadata object) or the
		// string `text`; parseMetadata degrades malformed input to an empty
		// graph.
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
	 * Shares the same ring buffer as incoming messages so ordering holds.
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
		// `debug_level 1+` injects a header BEFORE the curated render — same
		// shape the substrate Dumper produces. The header always appears
		// regardless of whether the curated render would suppress the
		// message (e.g. TM_EOF at level 0 returns null), so observers can
		// see EVERY arrival at level 1+.
		const level = this.debugLevelRef.current;
		if ( level >= 2 ) {
			// Level 2 REPLACES the normal render — the envelope dump is the
			// whole payload. Matches the substrate Dumper's
			// `if ($debug_level >= 2) { ... return; }`.
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
