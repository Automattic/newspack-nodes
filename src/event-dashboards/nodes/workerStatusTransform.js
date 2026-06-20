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
 * Read + write byte rates are NOT computed here — they come straight off each
 * worker descriptor, where the PROBE already computed them (Δbytes / Δ its own
 * 15s ts). That's the single rate source, so read and write move together at one
 * cadence; the old client-side delta (live `total_size` vs the 15s-stale cursor,
 * divided by the poll interval) is gone — it made the read rate flicker 0 between
 * probe ticks while the write rate kept moving.
 *
 * Stateful only for the segment slide-in/-out animation: it holds the PREVIOUS
 * snapshot's segment ids/data so the render path can flag genuinely-new and
 * just-removed segments, then emits `{ action:'model', model }` stamped TO=target.
 *
 * The model's `prevSegments` is the PRIOR snapshot's segment ids (so the render
 * path can flag genuinely-new segments for the slide-in animation); the node's
 * own `_prevSegments` is advanced synchronously for the NEXT delta. Across the
 * 1s–10s poll cadence this matches the old 500ms-delayed ref update.
 */
export class WorkerStatusTransformNode extends Node {
	constructor() {
		super();
		this._prevSegments = {}; // logKey → Set of segment ids
		this._prevSegmentData = {}; // logKey → Map id → segment
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
		const newPrevSegments = {};
		const newPrevSegmentData = {};
		const newByteRates = {};
		const newWriteRates = {};
		const newRemoving = {};

		// Byte rates come straight off each worker descriptor — the PROBE computed
		// them (Δbytes / Δ its own 15s ts), so read + write share one cadence and
		// we never client-delta a live value at a faster poll. byteRates keyed by
		// (handler, partition, source) so multi-Consumer handlers don't collapse;
		// writeRates keyed by the concrete partition (input_log) to match the
		// SegmentBar's rateKey.
		( data.workers || [] ).forEach( ( worker ) => {
			const workerKey = `${ worker.handler || worker.type }-${
				worker.partition
			}-${ worker.source || '' }`;
			newByteRates[ workerKey ] = Number( worker.read_rate ) || 0;
			if ( worker.input_log ) {
				newWriteRates[ worker.input_log ] =
					Number( worker.write_rate ) || 0;
			}
		} );

		// Segment tracking by concrete partition (logName.pN) for the slide-in/out
		// animation — union the segment ids across the workers reading/writing it.
		const logSnapshots = new Map();
		const recordLog = ( log ) => {
			if ( ! log || ! log.name ) {
				return;
			}
			const logKey = log.name;
			const prior = logSnapshots.get( logKey ) || { segments: new Map() };
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

		// Advance the segment-animation prev-state for the next snapshot.
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
