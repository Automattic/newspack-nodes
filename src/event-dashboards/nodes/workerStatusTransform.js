import { Node } from '../../runtime/node';
import {
	VALUE,
	TO,
	TYPE,
	TM_STRUCT,
	TM_ERROR,
	newMessage,
} from '../../runtime/message';

/**
 * `workerstatus:transform` — turn a `dump_graph` reply into the enriched
 * render model.
 *
 * Post-migration to substrate `_http`, the transform receives the reply
 * directly from HttpOut (TO=transform, FROM=workers): VALUE = `{ name, payload }`
 * where `payload` is the workers/logs metadata snapshot. Anything other than a
 * `dump_graph` reply is ignored — the view is the receiver for restart /
 * error replies (FROM=view).
 *
 * Stateful: it holds the PREVIOUS snapshot's per-worker positions, per-log
 * total sizes, segment ids/data, and a last-receive time on the node instance.
 * On each dump_graph reply it computes the delta vs that previous snapshot
 * (read rate per worker, write rate per log, segment add/remove) using
 * `Date.now()` for the time delta — exactly the math the old
 * `WorkerStatus.fetchWorkers` ran against its refs — then emits
 * `{ action:'model', model }` to its sink, stamped TO=target (→ view).
 *
 * The model's `prevSegments` is the PRIOR snapshot's segment ids (so the render
 * path can flag genuinely-new segments for the slide-in animation); the node's
 * own `_prevSegments` is advanced synchronously for the NEXT delta. Across the
 * 1s–10s poll cadence this matches the old 500ms-delayed ref update.
 */
export class WorkerStatusTransformNode extends Node {
	constructor() {
		super();
		this._prevPositions = {};
		this._prevTotalSizes = {};
		this._prevSegments = {}; // logKey → Set of segment ids
		this._prevSegmentData = {}; // logKey → Map id → segment
		this._lastReceiveTime = null;
		// Sticky scalars: a poll that OMITS segment_size / timestamp retains the
		// last good value (matches WorkerStatus's `if (data.x) setX(...)`). Seeds
		// match the old useState seeds — 64MB and the client clock.
		this._segmentSize = 64 * 1024 * 1024;
		this._currentTime = Math.floor( Date.now() / 1000 );
		// Worker_Base::HEARTBEAT_INTERVAL_S — the stall-pad denominator.
		this._heartbeatIntervalS = 10;
	}

	fill( message ) {
		// Overrides base Node.fill() (it builds a fresh out-message rather than
		// forwarding this one), so count here to keep the overlay's per-node
		// throughput honest.
		this.counter += 1;
		const value = message[ VALUE ];
		if ( ! value || 'object' !== typeof value ) {
			return;
		}
		const type = message[ TYPE ] || 0;
		// A TM_ERROR reply for our verb (poll failure) re-routes straight to
		// the view — the view's un-correlated-error path surfaces the disconnect
		// banner globally. The pending-Map path is irrelevant here (the hook
		// doesn't stash a resolver for the fire-and-forget poll).
		if ( 0 !== ( type & TM_ERROR ) ) {
			if ( this.sink ) {
				message[ TO ] = this.target;
				this.sink.fill( message );
			}
			return;
		}
		// Only act on dump_graph replies — the view is the receiver for
		// restart / error replies (FROM=view).
		if ( 'dump_graph' !== value.name ) {
			return;
		}
		this._emitModel( value.payload || {} );
	}

	// Compute the enriched model from `data` (vs the held previous snapshot),
	// advance the node's prev-state, and emit. Math ported verbatim from
	// WorkerStatus.fetchWorkers.
	_emitModel( data ) {
		const now = Date.now();

		const newPrevSegments = {};
		const newPrevSegmentData = {};
		const newPositions = {};
		const newByteRates = {};
		const newWriteRates = {};
		const newTotalSizes = {};
		const newRemoving = {};

		// Time delta in seconds; zero on the first snapshot (no prior receive).
		const timeDelta = this._lastReceiveTime
			? ( now - this._lastReceiveTime ) / 1000
			: 0;

		// Per-worker read rates, keyed by (handler, partition, source) so
		// multi-Consumer handlers don't collapse into one slot.
		( data.workers || [] ).forEach( ( worker ) => {
			const workerKey = `${ worker.handler || worker.type }-${
				worker.partition
			}-${ worker.source || '' }`;

			// Sum processed bytes across every input (workers tail many logs).
			let totalProcessed = 0;
			( worker.inputs_status || [] ).forEach( ( input ) => {
				if (
					input.cursor_seg === undefined ||
					input.cursor_offset === undefined
				) {
					return;
				}
				( input.segments || [] ).forEach( ( seg ) => {
					if ( seg.id < input.cursor_seg ) {
						totalProcessed += seg.size;
					} else if ( seg.id === input.cursor_seg ) {
						totalProcessed += input.cursor_offset;
					}
				} );
			} );
			newPositions[ workerKey ] = totalProcessed;

			if (
				timeDelta > 0 &&
				this._prevPositions[ workerKey ] !== undefined
			) {
				const bytesDelta =
					totalProcessed - this._prevPositions[ workerKey ];
				newByteRates[ workerKey ] =
					bytesDelta >= 0 ? bytesDelta / timeDelta : 0;
			}
		} );

		// Per-log write rates + segment tracking by (logName, partition); max
		// total_size and segment union so a stale snapshot can't shrink it.
		const logSnapshots = new Map();
		const recordLog = ( log ) => {
			if ( ! log || ! log.name ) {
				return;
			}
			// Flat data, grouped render: log.name is the concrete per-partition dir
			// (`firehose.p0`). Key on that concrete name verbatim — byte-identical
			// to TreeEntity's LogRows rateKey (the partition's concrete `name`), so
			// the grouped logical entity's rates line up regardless of layout.
			const logKey = log.name;
			const prior = logSnapshots.get( logKey ) || {
				total_size: 0,
				segments: new Map(),
			};
			prior.total_size = Math.max(
				prior.total_size,
				log.total_size || 0
			);
			( log.segments || [] ).forEach( ( seg ) => {
				prior.segments.set( seg.id, seg );
			} );
			logSnapshots.set( logKey, prior );
		};
		( data.workers || [] ).forEach( ( w ) => {
			( w.inputs_status || [] ).forEach( ( log ) => recordLog( log ) );
			( w.outputs_status || [] ).forEach( ( log ) => recordLog( log ) );
		} );

		logSnapshots.forEach( ( snap, logKey ) => {
			newTotalSizes[ logKey ] = snap.total_size;
			if (
				timeDelta > 0 &&
				this._prevTotalSizes[ logKey ] !== undefined
			) {
				const sizeDelta =
					snap.total_size - this._prevTotalSizes[ logKey ];
				newWriteRates[ logKey ] =
					sizeDelta >= 0 ? sizeDelta / timeDelta : 0;
			}
			const currentIds = new Set( snap.segments.keys() );
			newPrevSegments[ logKey ] = currentIds;
			newPrevSegmentData[ logKey ] = snap.segments;

			const prevIds = this._prevSegments[ logKey ];
			const prevData = this._prevSegmentData[ logKey ];
			if ( prevIds && prevData ) {
				const removed = [];
				for ( const id of prevIds ) {
					if ( ! currentIds.has( id ) ) {
						const segData = prevData.get( id );
						if ( segData ) {
							removed.push( segData );
						}
					}
				}
				if ( removed.length > 0 ) {
					newRemoving[ logKey ] = removed;
				}
			}
		} );

		// The model's prevSegments is the PRIOR snapshot (held before this
		// fill), so the render path flags this snapshot's new segments. The
		// node's own state then advances to the new snapshot for the next delta.
		const modelPrevSegments = this._prevSegments;

		// Sticky scalars: update only when present; a field-less poll keeps the
		// last good value instead of snapping back to a default.
		if ( data.segment_size ) {
			this._segmentSize = data.segment_size;
		}
		if ( data.timestamp ) {
			this._currentTime = data.timestamp;
		}
		if ( data.heartbeat_interval_s ) {
			this._heartbeatIntervalS = data.heartbeat_interval_s;
		}

		const model = {
			workers: data.workers || [],
			supervisor: data.supervisor ?? null,
			logs: data.logs || [],
			graph: data.graph ?? {},
			byteRates: newByteRates,
			writeRates: newWriteRates,
			segmentSize: this._segmentSize,
			currentTime: this._currentTime,
			heartbeatIntervalS: this._heartbeatIntervalS,
			prevSegments: modelPrevSegments,
			removingSegments: newRemoving,
			error: null,
			loading: false,
		};

		// Advance prev-state for the next snapshot.
		this._lastReceiveTime = now;
		this._prevPositions = newPositions;
		this._prevTotalSizes = newTotalSizes;
		this._prevSegments = newPrevSegments;
		this._prevSegmentData = newPrevSegmentData;

		if ( ! this.sink ) {
			return;
		}
		const out = newMessage();
		out[ TYPE ] = TM_STRUCT;
		// Rule #2: stamp TO=target so the exospine router routes it (→ view).
		out[ TO ] = this.target;
		out[ VALUE ] = { action: 'model', model };
		this.sink.fill( out );
	}
}
