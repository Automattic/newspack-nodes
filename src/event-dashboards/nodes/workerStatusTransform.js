import { Node } from '../../runtime/node';
import {
	VALUE,
	TO,
	TYPE,
	TM_STRUCT,
	TM_ERROR,
	newMessage,
} from '../../runtime/message';
import { reconstructWorkers } from './reconstructWorkers';

// A sample gap (Δ`data.timestamp`) beyond this many heartbeat intervals means
// the dashboard was paused (hidden tab) and resumed — the next sample's delta
// would span the whole gap, so rebaseline instead of dividing a huge Δvalue by a
// huge Δts and flashing a one-frame spike.
const GAP_INTERVALS = 6;

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
 * The dump_graph payload is now LEAN and POSITIONAL — PHP no longer pre-joins
 * worker attribution. This transform REBUILDS the old rich `workers[]` array
 * (the shape `topologyGraph.buildTopologySections` / `TreeEntity` / `SegmentBar`
 * read) by joining the four inputs: `graph` (.tsl structure), `workers`
 * (liveness only), `consumers` (per-reader probe STATE), and `logs` (live
 * segment lists) — see `reconstructWorkers`. The join lives entirely here so
 * everything downstream stays unchanged.
 *
 * Read/write byte rates are CLIENT-SIDE deltas across two polls (the probe no
 * longer rides a rate on each descriptor): read_rate = Δ(absolute cursor byte
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
	constructor() {
		super();
		this._prevSegments = {}; // logKey → Set of segment ids
		this._prevSegmentData = {}; // logKey → Map id → segment
		// Probe-cadence rate state: reader/source → { value, ts, rate }. Held
		// across polls so a rate only changes when new probe data advances.
		this._prevRead = {};
		this._prevWrite = {};
		// `data.timestamp` of the last processed snapshot — used to detect a long
		// hidden-tab gap and rebaseline the rate/segment state (see GAP_INTERVALS).
		this._lastSampleTs = null;
		// Sticky scalars: a poll that OMITS segment_size / timestamp retains the
		// last good value (matches WorkerStatus's `if (data.x) setX(...)`). Seeds
		// match the old useState seeds — 64MB and the client clock.
		this._segmentSize = 64 * 1024 * 1024;
		this._currentTime = Math.floor( Date.now() / 1000 );
		// Worker_Base::HEARTBEAT_INTERVAL_S — the stall-pad denominator.
		this._heartbeatIntervalS = 10;
		// On-disk log-partition count (the summary card); sticky like the scalars above.
		this._logPartitions = 0;
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

	// Rebuild the rich render model from the LEAN dump_graph payload: join the
	// four inputs into rich `workers[]` + rate maps (reconstructWorkers), then
	// advance the node's prev-state and emit.
	_emitModel( data ) {
		const newPrevSegments = {};
		const newPrevSegmentData = {};
		const newRemoving = {};

		// Hidden-tab gap detection: if this snapshot's timestamp jumped more than
		// GAP_INTERVALS heartbeat intervals past the last one, the dashboard was
		// paused and resumed. Drop the prev rate + segment state so this sample is
		// a fresh baseline (rate 0, no spurious segment removals) instead of a
		// gap-spanning one-frame spike.
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

		// Join graph + liveness + probe state + live segments into the rich
		// `workers[]` shape the downstream reads, plus the client-side rate
		// PROBE-cadence rate deltas (read = Δcursor-bytes, write = Δend-bytes,
		// each over the elapsed time since the probe last advanced — held between).
		const rebuilt = reconstructWorkers( data, {
			read: this._prevRead,
			write: this._prevWrite,
		} );
		const richWorkers = rebuilt.workers;
		// FULL live per-partition segments (the canonical logs[] the bar renders);
		// the bar derives its green/red/gray regions per tree from the consumer's
		// recorded end, so there is no global trim here.
		const liveLogs = rebuilt.logs;
		const newByteRates = rebuilt.byteRates;
		const newWriteRates = rebuilt.writeRates;

		// Segment tracking by concrete partition for the slide-in/out animation —
		// sourced from the live inputs_status (matching the bar that renders),
		// union the segment ids across the workers reading/writing it.
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

		// Advance the segment-animation + rate-delta prev-state for the next snapshot.
		this._prevSegments = newPrevSegments;
		this._prevSegmentData = newPrevSegmentData;
		this._prevRead = rebuilt.nextRead;
		this._prevWrite = rebuilt.nextWrite;

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
