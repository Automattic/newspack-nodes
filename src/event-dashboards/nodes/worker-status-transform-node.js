import { Node } from '../../runtime/node';
import {
	VALUE,
	TO,
	FROM,
	TYPE,
	TM_STRUCT,
	newMessage,
} from '../../runtime/message';
import { reconstructWorkers } from './reconstructWorkers';

/**
 * One live sample of a log: when its segments were stat'd, and each one's
 * size, the baseline its write rate falls back on when no probe stands. `reconstructWorkers` computes these and hands them
 * back; this node only carries them between polls.
 *
 * @typedef {{at:number,sizes:Object<number,number>}} LiveSample
 */

/**
 * Heartbeat intervals of silence that mean the tab was hidden, not the fleet
 * slow.
 *
 * Every segment rotated away during a gap that long would animate out at once,
 * so `_emitModel` drops the prior segments and starts from this snapshot. The
 * rates need no such reset: each divides a window its own probe timed, and
 * an unprobed log's live samples span the gap per segment, so retention
 * during it subtracts nothing.
 */
const GAP_INTERVALS = 6;

/**
 * `worker-status:transform` — turns a `dump_graph` reply into the enriched
 * render model the Worker Status view publishes.
 *
 * `addSliceFetcher` mounts it in the worker slice's `transform` slot, so the
 * join sits on the `worker-status:in` → `worker-status:view` edge rather than
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
 * two polls: the live samples of the logs it hands back on every call,
 * the prior snapshot's segment ids and data, the last sample timestamp, and
 * the sticky scalars a poll may omit. Both rates divide a window the probe
 * timed itself — a reader's bytes read, a log's bytes grown — so a sweep
 * slower than the poll never divides its work by the poll's interval. Reads
 * are keyed by reader and writes by concrete partition name, which is how
 * `TreeEntity` already reads them.
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
		 * Live sample per log-partition name.
		 *
		 * @type {Object<string,LiveSample>}
		 */
		this._prevLive = {};
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
	 * A `dump_graph` reply is transformed and anything else dropped. A refusal
	 * never arrives: the slice's gate sends it to the view, around this node.
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
	 * snapshot's heartbeat interval, so a stale segment set is discarded
	 * before this snapshot is compared with it. The model then reads the
	 * prior segment ids, and only afterwards does this node advance its own
	 * state — reversed, every segment would look already-seen and nothing
	 * would ever animate in.
	 *
	 * @param {Object} data The lean `dump_graph` payload: `graph`, `workers`,
	 *                      `consumers`, `logs`, `logs_at`, `timestamp`, the sticky
	 *                      scalars (`segment_size`, `heartbeat_interval_s`,
	 *                      `log_partitions`), `unparseable_lines`, the
	 *                      lines the probe-log read skipped, and
	 *                      `unreadable` and `refused_producers`, each name
	 *                      the snapshot left out with why. Those three are
	 *                      measurements of this poll, never sticky.
	 * @return {void}
	 */
	_emitModel( data ) {
		/** @type {Object<string,Set<number>>} */
		const newPrevSegments = {};
		/** @type {Object<string,Map<number,Object>>} */
		const newPrevSegmentData = {};
		/** @type {Object<string,Array<Object>>} */
		const newRemoving = {};

		// Hidden-tab gap (> GAP_INTERVALS): drop the prior segment set.
		const ts = data.timestamp;
		const maxGapS = this._heartbeatIntervalS * GAP_INTERVALS;
		if (
			null !== this._lastSampleTs &&
			ts !== undefined &&
			ts - this._lastSampleTs > maxGapS
		) {
			this._prevSegments = {};
			this._prevSegmentData = {};
		}
		this._lastSampleTs = ts !== undefined ? ts : this._lastSampleTs;

		// Join graph, liveness, probe state and live segments into workers[].
		const rebuilt = reconstructWorkers( data, this._prevLive );
		const richWorkers = rebuilt.workers;
		// FULL live per-partition segments; the bar derives regions itself.
		const liveLogs = rebuilt.logs;
		const newByteRates = rebuilt.byteRates;
		const newWriteRates = rebuilt.writeRates;

		// Every log a row draws, read or not, by the name its row keys on.
		liveLogs.forEach( ( log ) => {
			const logKey = log.name;
			const segments = new Map(
				( log.partitions?.[ 0 ]?.segments || [] ).map( ( seg ) => [
					seg.id,
					seg,
				] )
			);
			const currentIds = new Set( segments.keys() );
			newPrevSegments[ logKey ] = currentIds;
			newPrevSegmentData[ logKey ] = segments;

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
			unparseableLines: data.unparseable_lines,
			unreadable: data.unreadable ?? {},
			refusedProducers: data.refused_producers ?? {},
			segmentSize: this._segmentSize,
			currentTime: this._currentTime,
			heartbeatIntervalS: this._heartbeatIntervalS,
			prevSegments: modelPrevSegments,
			removingSegments: newRemoving,
			error: null,
			loading: false,
		};

		// Advance the segment + live-sample prev-state for the next snapshot.
		this._prevSegments = newPrevSegments;
		this._prevSegmentData = newPrevSegmentData;
		this._prevLive = rebuilt.nextLive;

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
