import { Node } from '../../runtime/node';
import {
	VALUE,
	TO,
	FROM,
	TYPE,
	TM_STRUCT,
	TM_ERROR,
	newMessage,
} from '../../runtime/message';
import { reconstructWorkers } from './reconstructWorkers';

// A gap beyond GAP_INTERVALS heartbeats = paused/resumed; rebaseline.
const GAP_INTERVALS = 6;

/**
 * `workerstatus:transform` — turn a `dump_graph` reply into the enriched
 * render model.
 *
 * The transform receives the reply
 * directly from HttpOut (TO=transform, FROM=workers): VALUE = `{ name, payload }`
 * where `payload` is the workers/logs metadata snapshot. Anything other than a
 * `dump_graph` reply is ignored — the view is the receiver for restart /
 * error replies (FROM=view).
 *
 * The dump_graph payload is LEAN and POSITIONAL — PHP does not pre-join
 * worker attribution. This transform REBUILDS the rich `workers[]` array
 * (the shape `topologyGraph.buildTopologySections` / `TreeEntity` / `SegmentBar`
 * read) by joining the four inputs: `graph` (.tsl structure), `workers`
 * (liveness only), `consumers` (per-reader probe STATE), and `logs` (live
 * segment lists) — see `reconstructWorkers`. The join lives entirely here so
 * everything downstream stays unchanged.
 *
 * Read/write byte rates are CLIENT-SIDE deltas across two polls: read_rate = Δ(absolute cursor byte
 * position)/Δts, write_rate = Δ(partition total live bytes)/Δts, both keyed as
 * the downstream already reads them. Stateful for the rate deltas (per-reader
 * prior cursor position, per-source prior total bytes) and the segment
 * slide-in/-out animation (PREVIOUS snapshot's segment ids/data, sourced from
 * the TRIMMED inputs_status so animations match what's rendered).
 *
 * The model's `prevSegments` is the PRIOR snapshot's segment ids (so the render
 * path can flag genuinely-new segments for the slide-in animation); the node's
 * own `_prevSegments` is advanced synchronously for the NEXT delta.
 */
export class WorkerStatusTransformNode extends Node {
	// View-model/infra node: never a user-added node (see useGraphReset).
	static isSystemNode = true;

	/**
	 * Seed the cross-poll state this transform carries: the previous snapshot's
	 * segment ids and data (segment slide-in/-out animation), the per-reader and
	 * per-source rate baselines, the last sample timestamp (hidden-tab gap
	 * detection), and the sticky scalars a poll may omit.
	 */
	constructor() {
		super();
		this._prevSegments = {}; // logKey → Set of segment ids
		this._prevSegmentData = {}; // logKey → Map id → segment
		// Probe-cadence rate state: reader/source → { value, ts, rate }.
		this._prevRead = {};
		this._prevWrite = {};
		// Last snapshot's data.timestamp; detects a hidden-tab gap.
		this._lastSampleTs = null;
		// Sticky scalars: a poll omitting a field retains the last good value.
		this._segmentSize = 64 * 1024 * 1024;
		this._currentTime = Math.floor( Date.now() / 1000 );
		// Worker_Base::HEARTBEAT_INTERVAL_S — the stall-pad denominator.
		this._heartbeatIntervalS = 10;
		// On-disk log-partition count (summary card); sticky like above.
		this._logPartitions = 0;
	}

	/**
	 * Accept a poll reply and emit the render model. A TM_ERROR re-routes
	 * untouched to the view's error path; only a `dump_graph` reply is
	 * transformed, and anything else is dropped (the view owns restart replies).
	 *
	 * @param {Array} message The 7-field positional message; VALUE is `{ name,
	 *                        payload }` where `payload` is the metadata snapshot.
	 */
	fill( message ) {
		// Overrides base fill() (mints a new message); count here for overlay.
		this.counter += 1;
		const value = message[ VALUE ];
		if ( ! value || 'object' !== typeof value ) {
			return;
		}
		const type = message[ TYPE ] || 0;
		// A TM_ERROR (poll failure) re-routes to the view's error path.
		if ( 0 !== ( type & TM_ERROR ) ) {
			if ( this.sink ) {
				message[ TO ] = this.target;
				this.sink.fill( message );
			}
			return;
		}
		// Only act on dump_graph replies; the view handles restart/error.
		if ( 'dump_graph' !== value.name ) {
			return;
		}
		this._emitModel( value.payload || {} );
	}

	/**
	 * Rebuild the rich render model from the lean dump_graph payload and send it
	 * to the target as `{ action: 'model', model }`. Advances the segment and
	 * rate-delta state for the next snapshot.
	 *
	 * @param {Object} data The lean dump_graph payload: `graph`, `workers`,
	 *                      `consumers`, `logs`, `supervisor`, `timestamp`, and
	 *                      the sticky scalars (`segment_size`,
	 *                      `heartbeat_interval_s`, `log_partitions`).
	 */
	_emitModel( data ) {
		const newPrevSegments = {};
		const newPrevSegmentData = {};
		const newRemoving = {};

		// Hidden-tab gap (> GAP_INTERVALS): drop prev state, fresh baseline.
		const ts = data.timestamp;
		const maxGapS = this._heartbeatIntervalS * GAP_INTERVALS;
		if (
			null !== this._lastSampleTs &&
			ts !== undefined &&
			ts - this._lastSampleTs > maxGapS
		) {
			this._prevRead = {};
			this._prevWrite = {};
			this._prevSegments = {};
			this._prevSegmentData = {};
		}
		this._lastSampleTs = ts !== undefined ? ts : this._lastSampleTs;

		// Join graph + liveness + probe state + live segments → rich workers[].
		const rebuilt = reconstructWorkers( data, {
			read: this._prevRead,
			write: this._prevWrite,
		} );
		const richWorkers = rebuilt.workers;
		// FULL live per-partition segments; the bar derives regions itself.
		const liveLogs = rebuilt.logs;
		const newByteRates = rebuilt.byteRates;
		const newWriteRates = rebuilt.writeRates;

		// Segment tracking per partition for the slide-in/out animation.
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
		richWorkers.forEach( ( w ) => {
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

		// model.prevSegments = the PRIOR snapshot (flags this one's new segs).
		const modelPrevSegments = this._prevSegments;

		// Sticky scalars: update only when present (else keep last good).
		if ( data.segment_size ) {
			this._segmentSize = data.segment_size;
		}
		if ( data.timestamp ) {
			this._currentTime = data.timestamp;
		}
		if ( data.heartbeat_interval_s ) {
			this._heartbeatIntervalS = data.heartbeat_interval_s;
		}
		if ( data.log_partitions !== undefined ) {
			this._logPartitions = data.log_partitions;
		}

		const model = {
			workers: richWorkers,
			supervisor: data.supervisor ?? null,
			logs: liveLogs,
			graph: data.graph ?? {},
			byteRates: newByteRates,
			writeRates: newWriteRates,
			logPartitions: this._logPartitions,
			segmentSize: this._segmentSize,
			currentTime: this._currentTime,
			heartbeatIntervalS: this._heartbeatIntervalS,
			prevSegments: modelPrevSegments,
			removingSegments: newRemoving,
			error: null,
			loading: false,
		};

		// Advance the segment + rate-delta prev-state for the next snapshot.
		this._prevSegments = newPrevSegments;
		this._prevSegmentData = newPrevSegmentData;
		this._prevRead = rebuilt.nextRead;
		this._prevWrite = rebuilt.nextWrite;

		if ( ! this.sink ) {
			return;
		}
		const out = newMessage();
		out[ TYPE ] = TM_STRUCT;
		// Mint: stamp FROM = our name; TO=target so the router routes it.
		out[ FROM ] = this.name;
		out[ TO ] = this.target;
		out[ VALUE ] = { action: 'model', model };
		this.sink.fill( out );
	}
}
