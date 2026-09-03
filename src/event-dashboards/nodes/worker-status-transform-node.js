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

/**
 * One rate step: a byte position, when it last advanced, and the rate that
 * advance produced. `reconstructWorkers` computes these and hands them back;
 * this node only carries them between polls.
 *
 * @typedef {{value:number,ts:number,rate:number}} RateStep
 */

/**
 * Heartbeat intervals of silence that mean the tab was hidden, not the fleet
 * slow.
 *
 * Everything carried across a gap that long describes a window nobody watched:
 * every segment rotated away during it would animate out at once, and the rate
 * baselines predate a stretch of unobserved work. `_emitModel` drops all four
 * pieces of prior state and starts from this snapshot instead.
 */
const GAP_INTERVALS = 6;

/**
 * `workerstatus:transform` — turns a `dump_graph` reply into the enriched
 * render model the Worker Status view publishes.
 *
 * `addSliceFetcher` mounts it in the worker slice's `transform` slot, so the
 * join sits on the `workerstatus:in` → `workerstatus:view` edge rather than
 * inside the view: the Fetcher mints `dump_graph` under the receiver Tee's
 * name, the server replies TO=FROM, and the Tee fans that reply here. `target`
 * is the view. A reply arrives as VALUE = `{ name, payload }`, and only a
 * `dump_graph` one is transformed — `restart`, `activate` and `deactivate`
 * mint under the view's own name, so their replies land there instead.
 *
 * The payload is LEAN and POSITIONAL. PHP ships four independent sections —
 * `graph` (the `.tsl` structure), `workers` (liveness), `consumers` (per-reader
 * probe state) and `logs` (live segment lists) — and pre-joins no worker
 * attribution, because one verb answering from one atomic snapshot is what
 * keeps the four coherent. `reconstructWorkers` joins them here into the rich
 * `workers[]` array that `topologyGraph.buildTopologySections`, `TreeEntity`
 * and `SegmentBar` read, so the join lives in one place and nothing downstream
 * sees the lean shape.
 *
 * `reconstructWorkers` is stateless, so this node carries everything spanning
 * two polls: the rate baselines it hands back on every call, the prior
 * snapshot's segment ids and data, the last sample timestamp, and the sticky
 * scalars a poll may omit. Rates run on the PROBE's cadence rather than the
 * poll's — `steppedRate` recomputes only when a byte position actually
 * advances — because the cursor and end positions come from a sweep slower
 * than the poll, and a poll-clock delta would read zero repeatedly and then
 * spike. Reads are keyed by reader and writes by concrete partition name,
 * which is how `TreeEntity` already reads them.
 *
 * The model's `prevSegments` is the PRIOR snapshot's segment ids, which is what
 * lets the render path tell a genuinely new segment from one already drawn;
 * `_prevSegments` advances to this snapshot for the next delta.
 */
export class WorkerStatusTransformNode extends Node {
	/**
	 * Seeds every piece of cross-poll state, since `reconstructWorkers` keeps
	 * none of its own. The sticky scalars start at the values the substrate
	 * ships as defaults, so a render before the first reply is shaped rather
	 * than blank.
	 */
	constructor() {
		super();
		/**
		 * The prior snapshot's segment ids per concrete partition name. A
		 * segment absent from its entry is new, and animates in.
		 *
		 * @type {Object<string,Set<number>>}
		 */
		this._prevSegments = {};
		/**
		 * The prior snapshot's segments themselves, per concrete partition
		 * name. Ids alone say a segment left; the record is what draws it
		 * while it animates out.
		 *
		 * @type {Object<string,Map<number,Object>>}
		 */
		this._prevSegmentData = {};
		/**
		 * Read-rate baseline per reader id.
		 *
		 * @type {Object<string,RateStep>}
		 */
		this._prevRead = {};
		/**
		 * Write-rate baseline per concrete partition name.
		 *
		 * @type {Object<string,RateStep>}
		 */
		this._prevWrite = {};
		/**
		 * The last snapshot's `data.timestamp`, the clock the hidden-tab gap
		 * is measured against. Null until the first reply arrives.
		 *
		 * @type {?number}
		 */
		this._lastSampleTs = null;
		/**
		 * Segment size in bytes, scaling the segment bars. Sticky: a poll
		 * that omits the field keeps the last good value.
		 *
		 * @type {number}
		 */
		this._segmentSize = 64 * 1024 * 1024;
		/**
		 * The server's clock at the last snapshot, in seconds — what the
		 * render path ages heartbeats and uptimes against. Sticky.
		 *
		 * @type {number}
		 */
		this._currentTime = Math.floor( Date.now() / 1000 );
		/**
		 * The fleet's heartbeat interval in seconds
		 * (`Worker_Base::HEARTBEAT_INTERVAL_S`), the unit `GAP_INTERVALS`
		 * multiplies into the hidden-tab gap threshold. Sticky.
		 *
		 * @type {number}
		 */
		this._heartbeatIntervalS = 10;
		/**
		 * On-disk log-partition count, which `SummaryCards` shows. Sticky.
		 *
		 * @type {number}
		 */
		this._logPartitions = 0;
	}

	/**
	 * Absorb one poll reply and emit the render model.
	 *
	 * A TM_ERROR is re-addressed to the view and forwarded untouched, so the
	 * disconnect banner surfaces without this node inventing a model. A
	 * `dump_graph` reply is transformed; anything else is dropped, because the
	 * mutation replies it would otherwise see belong to the view.
	 *
	 * @param {Array} message The 7-field positional message; VALUE is `{ name,
	 *                        payload }` where `payload` is the snapshot.
	 * @return {void}
	 */
	fill( message ) {
		// Base fill() counts; this override never calls it, so count here.
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
	 * Rebuild the rich render model from the lean `dump_graph` payload and send
	 * it to the target as `{ action: 'model', model }`.
	 *
	 * The order matters. The gap check runs first, against the PREVIOUS
	 * snapshot's heartbeat interval, so a rebaseline discards the stale state
	 * before `reconstructWorkers` deltas against it. The model then reads the
	 * prior segment ids, and only afterwards does this node advance its own
	 * state — reversed, every segment would look already-seen and nothing
	 * would ever animate in.
	 *
	 * @param {Object} data The lean `dump_graph` payload: `graph`, `workers`,
	 *                      `consumers`, `logs`, `timestamp`, and the sticky
	 *                      scalars (`segment_size`, `heartbeat_interval_s`,
	 *                      `log_partitions`).
	 * @return {void}
	 */
	_emitModel( data ) {
		/** @type {Object<string,Set<number>>} */
		const newPrevSegments = {};
		/** @type {Object<string,Map<number,Object>>} */
		const newPrevSegmentData = {};
		/** @type {Object<string,Array<Object>>} */
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

		// Join graph, liveness, probe state and live segments into workers[].
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

		// model.prevSegments is the PRIOR snapshot, flagging new segments.
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
		// A mint: stamp FROM with our name, TO with the target, for Router.
		out[ FROM ] = this.name;
		out[ TO ] = this.target;
		out[ VALUE ] = { action: 'model', model };
		this.sink.fill( out );
	}
}
