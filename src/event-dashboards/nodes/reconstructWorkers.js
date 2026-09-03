/**
 * Join the lean `dump_graph` payload into the rich `workers[]` array that
 * `topologyGraph.buildTopologySections`, `TreeEntity` and `SegmentBar` read.
 *
 * `Workers_CI::cmd_dump_graph` answers four unjoined views, because PHP does no
 * worker attribution; the browser walks the graph once per poll instead.
 *
 * - `graph` is the declared `.tsl` structure, one `{nodes,edges}` per topology.
 *   A `consumer` node carries `reads`, its source-log template, and `reader`,
 *   its offsetlog template.
 * - `workers` carries liveness alone, one row per (type, partition).
 * - `consumers` carries each reader's probe state: its cursor, the partition
 *   end it recorded, and how far behind that leaves it.
 * - `logs` carries the live per-partition segment lists.
 *
 * A template still holds its `<partition>` and `<topology>` tokens, and
 * `topologyGraph.substituteTokens` is the one thing that resolves them, so a
 * match never parses a concrete name by position.
 *
 * `SegmentBar` receives the UNTRIMMED live segments plus each consumer's
 * recorded `(end_segment, end_size)` and derives its three regions from the two
 * together: what the reader has consumed, what it still owes, and what the
 * writer appended after the reader's last probe. Trimming the segments to the
 * recorded end here would erase that third region for every tree at once.
 */

import { contractTees, substituteTokens } from '../topologyGraph';

/**
 * Does a probe row's reader id belong to the named consumer?
 *
 * A reader id is the consumer's own name, or that name followed by a separator
 * and a suffix — `prereq.p0`, `prereq-0`. Demanding the `.`, `_` or `-` is what
 * stops `prereq` from claiming `prereq2.p0`.
 *
 * @param {string} reader Reader id carried by a probe row.
 * @param {string} name   Consumer node name from the graph.
 * @return {boolean} True when the reader id names that consumer.
 */
const readerIsHandler = ( reader, name ) =>
	reader === name ||
	( reader.startsWith( name ) &&
		/^[._-]/.test( reader.slice( name.length ) ) );

/**
 * Resolve every logic handler each `consumer` node feeds.
 *
 * `contractTees` replaces the pair `x→tee`, `tee→y` with the direct edge `x→y`,
 * which lands a consumer on the same collapsed vertices
 * `topologyGraph.collapseGraph` renders. Both readers of a `.tsl` graph share
 * that ONE implementation, because a worker row attributed to a vertex the tree
 * never draws is a row nobody sees.
 *
 * A consumer that fans through a tee to several processors — a firehose feeding
 * both the request-builder and the job-router — yields one handler EACH, so
 * every processor's vertex gets its own worker row. Taking only the first
 * silently drops the other processors' tree rows. A consumer feeding a log
 * directly, with no logic node between, falls back to its own name.
 *
 * @param {Object} graphTopo One topology's `{ nodes:[{name,kind,reads?,reader?}], edges:[[from,to]] }`.
 * @return {Array<{name:string,sourceTemplate:string,readerTemplate:string,handlers:string[]}>} One entry
 *   per consumer node: its name, its source-log template, the offsetlog template that names its reader,
 *   and every handler its rows attach to. Both templates still carry their `<partition>`/`<topology>`
 *   tokens.
 */
function consumerHandlers( graphTopo ) {
	const nodes = Array.isArray( graphTopo?.nodes ) ? graphTopo.nodes : [];
	const rawEdges = Array.isArray( graphTopo?.edges ) ? graphTopo.edges : [];
	const kindOf = new Map( nodes.map( ( n ) => [ n.name, n.kind ] ) );

	// Same collapsed vertices `buildTopologySections` renders (raw names).
	const edges = contractTees(
		rawEdges,
		( name ) => 'tee' === kindOf.get( name )
	);

	const outAdj = new Map();
	edges.forEach( ( [ a, b ] ) => {
		if ( ! outAdj.has( a ) ) {
			outAdj.set( a, [] );
		}
		outAdj.get( a ).push( b );
	} );

	const out = [];
	nodes.forEach( ( node ) => {
		if ( 'consumer' !== node.kind ) {
			return;
		}
		// Distinct Tee branches can legitimately converge on one handler.
		const downstream = [
			...new Set(
				( outAdj.get( node.name ) || [] ).filter(
					( n ) => 'logic' === kindOf.get( n )
				)
			),
		];
		out.push( {
			name: node.name,
			sourceTemplate: node.reads || '',
			// Offsetlog basename = UNIQUE reader id; match probes by it.
			readerTemplate: node.reader || '',
			handlers: downstream.length > 0 ? downstream : [ node.name ],
		} );
	} );
	return out;
}

/**
 * Total bytes the live segments hold — the partition's full size on disk.
 *
 * @param {Array<{size?:number}>} segments One partition's live segment list.
 * @return {number} Sum of every segment's size.
 */
const liveTotal = ( segments ) =>
	segments.reduce( ( acc, seg ) => acc + ( seg.size || 0 ), 0 );

/**
 * Absolute byte position of `(segment, offset)`: every whole segment behind
 * `segment`, plus the offset inside it.
 *
 * Segment ids only ever rise, so `id < segment` means "already behind". The
 * total is measured from the oldest LIVE segment, so a retention sweep dropping
 * an old segment shrinks it — the backward move `steppedRate` rebaselines on
 * rather than reporting as a negative rate.
 *
 * @param {Array<{id:number,size:number}>} segments Live segments, in any order.
 * @param {number}                         segment  Segment the position sits in.
 * @param {number}                         offset   Byte offset inside `segment`.
 * @return {number} Bytes from the start of the oldest live segment.
 */
const bytePosition = ( segments, segment, offset ) =>
	segments.reduce(
		( acc, seg ) => ( seg.id < segment ? acc + seg.size : acc ),
		0
	) + offset;

/**
 * Advance one probe-cadence rate step.
 *
 * The cursor and end byte positions come from the Topic_Probe sweep, which runs
 * every 15s, while the dashboard polls `dump_graph` every 5s. Deltaing against
 * the poll clock would report two zeros and then a 3× spike. The rate is
 * recomputed only when the value ADVANCES — which is new probe data — over the
 * real elapsed time since that last advance, and HELD while the value stands. A
 * value that moves backward (a retention sweep, a worker restart) rebaselines
 * and keeps the last rate rather than spiking negative.
 *
 * @param {{value:number,ts:number,rate:number}|undefined} prev  Prior step; undefined on the first sample.
 * @param {number}                                         value Current byte position.
 * @param {number}                                         now   Snapshot time, in seconds.
 * @return {{value:number,ts:number,rate:number}} The step to carry into the next poll.
 */
function steppedRate( prev, value, now ) {
	if ( ! prev ) {
		return { value, ts: now, rate: 0 }; // first sample — nothing to delta
	}
	if ( value > prev.value && now > prev.ts ) {
		return {
			value,
			ts: now,
			rate: ( value - prev.value ) / ( now - prev.ts ),
		};
	}
	if ( value === prev.value ) {
		return { value, ts: prev.ts, rate: prev.rate }; // unchanged → hold
	}
	return { value, ts: now, rate: prev.rate }; // backward → rebaseline
}

/**
 * Join the four lean inputs into the rich `workers[]` array plus the two rate
 * maps `globalRates` sums.
 *
 * Nothing is held between polls: the caller passes the previous poll's rate
 * baselines and gets the next ones back. The state stays in the transform node,
 * and the join stays a plain function a test can call twice.
 *
 * Both rates run on the PROBE cadence rather than the poll cadence — see
 * `steppedRate`. The `logs` come back untouched, so the segment bar still sees
 * the full live data.
 *
 * @param {Object} data  The `dump_graph` payload: `graph`, `workers`, `consumers`, `logs`, `timestamp`.
 * @param {Object} prior Previous poll's rate baselines: `read` keyed by reader id, `write` by source.
 * @return {Object} `{ workers, logs, byteRates, writeRates, nextRead, nextWrite }` — the rich rows, the
 *   live logs, read rate per reader, write rate per source, and the two baselines for the next poll.
 */
export function reconstructWorkers( data, prior ) {
	const graph = data.graph || {};
	const liveness = data.workers || [];
	const consumers = data.consumers || [];
	const logs = data.logs || [];
	const ts = data.timestamp;
	const priorRead = prior.read || {};
	const priorWrite = prior.write || {};

	// Live per-(name, partition) segment lists, indexed by concrete source.
	const liveByName = new Map();
	logs.forEach( ( log ) => {
		( log.partitions || [] ).forEach( ( p ) => {
			liveByName.set(
				`${ log.name }#${ p.partition }`,
				p.segments || []
			);
		} );
	} );

	// Liveness indexed by `type#partition`.
	const liveByKey = new Map();
	liveness.forEach( ( w ) =>
		liveByKey.set( `${ w.type }#${ w.partition }`, w )
	);

	const workers = [];
	const byteRates = {};
	const writeRates = {};
	const nextRead = {};
	const nextWrite = {};

	// Write rate = Δ(probe END); collapse per source to MAX end (monotonic).
	const writeTotals = new Map();
	consumers.forEach( ( row ) => {
		const live =
			liveByName.get( `${ row.source }#${ row.partition }` ) || [];
		// The probe's recorded HEAD; capping end_size stalls the rate.
		const total = bytePosition( live, row.end_segment, row.end_size );
		const prevMax = writeTotals.get( row.source );
		if ( prevMax === undefined || total > prevMax ) {
			writeTotals.set( row.source, total );
		}
	} );
	// Output logs (no consumer) fall back to live head; only fill new keys.
	logs.forEach( ( log ) => {
		( log.partitions || [] ).forEach( ( p ) => {
			if ( writeTotals.has( log.name ) ) {
				return;
			}
			writeTotals.set( log.name, liveTotal( p.segments || [] ) );
		} );
	} );
	writeTotals.forEach( ( total, source ) => {
		const step = steppedRate( priorWrite[ source ], total, ts );
		nextWrite[ source ] = step;
		writeRates[ source ] = step.rate;
	} );

	// Read step per reader, once up front; inside the loop it is N×M.
	const readStepByReader = new Map();
	consumers.forEach( ( row ) => {
		if ( readStepByReader.has( row.reader ) ) {
			return;
		}
		const live =
			liveByName.get( `${ row.source }#${ row.partition }` ) || [];
		const step = steppedRate(
			priorRead[ row.reader ],
			bytePosition( live, row.cursor_segment, row.cursor_offset ),
			ts
		);
		readStepByReader.set( row.reader, step );
		nextRead[ row.reader ] = step;
		// @longform Key by READER, which is what a fleet-wide sum needs.
		// A handler key counts a reader fanning through a Tee once per
		// downstream handler, and a source key merges two topologies
		// reading that one source into a single last-write-wins entry.
		byteRates[ row.reader ] = step.rate;
	} );

	Object.entries( graph ).forEach( ( [ topology, graphTopo ] ) => {
		const handlers = consumerHandlers( graphTopo );

		// One worker per probe row; resolve handler by its reads-template.
		consumers.forEach( ( row ) => {
			// Match by READER (unique); fall back to source when no reader.
			const bindings = { partition: row.partition, topology };
			const matching = handlers.filter( ( h ) =>
				h.readerTemplate
					? substituteTokens( h.readerTemplate, bindings ) ===
					  row.reader
					: substituteTokens( h.sourceTemplate, bindings ) ===
					  row.source
			);
			if ( 0 === matching.length ) {
				return;
			}
			const chosen =
				matching.find( ( h ) =>
					readerIsHandler( String( row.reader ), h.name )
				) || matching[ 0 ];
			const concrete = row.source;

			const live =
				liveByName.get( `${ concrete }#${ row.partition }` ) || [];
			const status = liveByKey.get( `${ topology }#${ row.partition }` );

			// Drop a ghost reader: undeclared partition AND no live worker.
			if (
				! liveByName.has( `${ concrete }#${ row.partition }` ) &&
				! ( status && status.live )
			) {
				return;
			}

			// One worker row per downstream handler (fan-out: each vertex).
			const inputsStatus = {
				name: concrete,
				partition: row.partition,
				segments: live,
				total_size: liveTotal( live ),
				cursor_segment: row.cursor_segment,
				cursor_offset: row.cursor_offset,
				end_segment: row.end_segment,
				end_size: row.end_size,
			};

			// Read rate: computed once per reader, not here per topology.
			const readStep = readStepByReader.get( row.reader );

			chosen.handlers.forEach( ( handler ) => {
				workers.push( {
					type: topology,
					handler,
					source: concrete,
					partition: row.partition,
					status: status ? status.status : 'dead',
					live: status ? status.live : false,
					stale: status ? status.stale : false,
					idle: status ? !! status.idle : false,
					restart_pending: status ? status.restart_pending : false,
					heartbeat_age: status ? status.heartbeat_age : null,
					started_at: status ? status.started_at : null,
					cursor_segment: row.cursor_segment,
					cursor_offset: row.cursor_offset,
					behind: row.distance,
					read_rate: readStep.rate,
					inputs: [ concrete ],
					outputs: [],
					inputs_status: [ inputsStatus ],
					outputs_status: [],
				} );
			} );
			// Write rate: once per source up front, not per row here.
		} );

		// A liveness row with no consumer row still emits a worker row.
		const emitted = new Set(
			workers
				.filter( ( w ) => w.type === topology )
				.map( ( w ) => w.partition )
		);
		liveness.forEach( ( w ) => {
			if ( w.type !== topology || emitted.has( w.partition ) ) {
				return;
			}
			emitted.add( w.partition );
			workers.push( {
				type: topology,
				handler: topology,
				source: '',
				partition: w.partition,
				status: w.status,
				live: w.live,
				stale: w.stale,
				idle: !! w.idle,
				restart_pending: w.restart_pending,
				heartbeat_age: w.heartbeat_age,
				started_at: w.started_at,
				cursor_segment: undefined,
				cursor_offset: undefined,
				behind: 0,
				inputs: [],
				outputs: [],
				inputs_status: [],
				outputs_status: [],
			} );
		} );
	} );

	return {
		workers,
		logs,
		byteRates,
		writeRates,
		nextRead,
		nextWrite,
	};
}
