/**
 * Rebuild the RICH `workers[]` array (the pre-migration shape that
 * `topologyGraph.buildTopologySections` / `TreeEntity` / `SegmentBar` read)
 * from the lean positional `dump_graph` payload, by joining the four inputs:
 *
 *   graph     — the `.tsl` structure ({ topology → { nodes, edges } }); a
 *               `consumer` node carries `reads` = its source-log template.
 *   workers   — LIVENESS only per (type, partition).
 *   consumers — per-reader probe STATE (cursor / partition end / distance).
 *   logs      — LIVE per-partition segment lists.
 *
 * The segment bar paints the FULL live segments in three regions (green read,
 * red/yellow recorded backlog, gray live-beyond-the-probe), so this join carries
 * the untrimmed live segments through plus each consumer's recorded (end_segment,
 * end_size) — the bar derives the regions itself per tree, never a global trim.
 *
 * PARTITION token substitution mirrors `topologyGraph.concreteLogNames`: a
 * `<partition>` in the consumer's `reads` template becomes the partition NUMBER.
 */

const PARTITION_TOKEN = '<partition>';
const TOPOLOGY_TOKEN = '<topology>';

/**
 * Resolve a path template the way Topology_Loader binds it: `<partition>` AND
 * `<topology>`. An offsetlog is a reader's cursor and the reader is the FLEET, so
 * reader templates carry `<topology>` — substituting only the partition left
 * `firehose.<topology>.p0` never matching the live `firehose.combined.p0`, which
 * cost every segment bar its cursor and painted the lot grey.
 *
 * @param {string} template   Path template.
 * @param {number} partition  Partition index.
 * @param {string} [topology] Fleet name; omitted leaves `<topology>` alone.
 * @return {string} Concrete path.
 */
const concreteSource = ( template, partition, topology ) => {
	let out = template;
	if ( out.includes( PARTITION_TOKEN ) ) {
		out = out.split( PARTITION_TOKEN ).join( String( partition ) );
	}
	if ( topology && out.includes( TOPOLOGY_TOKEN ) ) {
		out = out.split( TOPOLOGY_TOKEN ).join( String( topology ) );
	}
	return out;
};

// reader === name, or name followed by a separator suffix (prereq.p0/-0).
const readerIsHandler = ( reader, name ) =>
	reader === name ||
	( reader.startsWith( name ) &&
		/^[._-]/.test( reader.slice( name.length ) ) );

/**
 * For each `consumer` node, resolve ALL the logic handlers it feeds — every
 * non-tee/non-log node reachable after contracting `tee` nodes out (same in×out
 * → direct-edge contraction as `topologyGraph.collapseGraph`). A consumer that
 * fans through a tee to several processors (firehose → request-builder AND
 * job-router) yields one handler EACH, so each processor's collapsed-graph
 * vertex gets its own worker row (one row per target) —
 * picking only the first would silently drop the other processors' tree rows.
 * A consumer feeding a log directly (no logic node) falls back to its own name.
 *
 * @param {Object} graphTopo `{ nodes:[{name,kind,reads?}], edges:[[from,to]] }`.
 * @return {Array<{name:string,sourceTemplate:string,handlers:string[]}>} One per consumer node.
 */
function consumerHandlers( graphTopo ) {
	const nodes = Array.isArray( graphTopo?.nodes ) ? graphTopo.nodes : [];
	const rawEdges = Array.isArray( graphTopo?.edges ) ? graphTopo.edges : [];
	const kindOf = new Map( nodes.map( ( n ) => [ n.name, n.kind ] ) );
	const isTee = ( name ) => 'tee' === kindOf.get( name );

	// Contract tees: replace x→T, T→y with x→y (as collapseGraph, raw names).
	let edges = rawEdges.map( ( e ) => [ e[ 0 ], e[ 1 ] ] );
	while ( edges.some( ( [ a, b ] ) => isTee( a ) || isTee( b ) ) ) {
		const tee = edges.flatMap( ( [ a, b ] ) => [ a, b ] ).find( isTee );
		const ins = edges
			.filter( ( [ , b ] ) => b === tee )
			.map( ( [ a ] ) => a );
		const outs = edges
			.filter( ( [ a ] ) => a === tee )
			.map( ( [ , b ] ) => b );
		const rest = edges.filter( ( [ a, b ] ) => a !== tee && b !== tee );
		ins.forEach( ( a ) => outs.forEach( ( b ) => rest.push( [ a, b ] ) ) );
		edges = rest;
	}

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
		// @longform Only logic nodes are valid handlers; else consumer's own name.
		// Dedup: a target reachable both directly AND through a contracted tee
		// (combined's disconnect+rewire) would emit a duplicate worker badge.
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

// Sum of every live segment's size — the partition's full size on disk.
const liveTotal = ( segments ) =>
	segments.reduce( ( acc, seg ) => acc + ( seg.size || 0 ), 0 );

// Absolute byte position of a cursor: full segments behind it + offset.
const cursorBytes = ( segments, cursorSegment, cursorOffset ) =>
	segments.reduce(
		( acc, seg ) => ( seg.id < cursorSegment ? acc + seg.size : acc ),
		0
	) + cursorOffset;

// Partition HEAD position; does NOT cap endSize (it lags, stuck W at 0).
const endPosition = ( segments, endSegment, endSize ) =>
	segments.reduce(
		( acc, seg ) => ( seg.id < endSegment ? acc + seg.size : acc ),
		0
	) + endSize;

/**
 * Probe-cadence rate step. The cursor/end byte positions come from the 15s
 * TopicProbe snapshot but dump_graph polls ~1s, so deltaing against the poll
 * clock gives 14 zeros then a 15× spike. Instead recompute ONLY when the value
 * actually advances (= new probe data), over the real elapsed time since the
 * last advance, and HOLD the rate while the value is unchanged. A value that
 * goes backward (segment GC / worker restart) rebaselines and holds the last
 * rate rather than spiking negative.
 *
 * @param {?{value:number,ts:number,rate:number}} prev  Prior step (or undefined).
 * @param {number}                                value Current byte position.
 * @param {number}                                now   Current snapshot time (s).
 * @return {{value:number,ts:number,rate:number}} The next step (carry forward).
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
 * Join the four lean inputs into the rich `workers[]` array plus the
 * partition-keyed rate maps the downstream reads. Stateless: the caller passes
 * the prior-poll rate state and gets the next state back, so the node owns no
 * join logic. Rates are PROBE-cadence (see `steppedRate`) — the segment lists
 * carry the FULL live data (the bar derives its regions from the recorded end).
 *
 * @param {Object} data  The lean dump_graph payload (`graph`, `workers`, `consumers`, `logs`, `timestamp`).
 * @param {Object} prior `{ read:{reader→step}, write:{source→step} }` from the previous poll.
 * @return {Object} `{ workers, logs, byteRates, writeRates, nextRead, nextWrite }`.
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
		const total = endPosition( live, row.end_segment, row.end_size );
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
			const head = ( p.segments || [] ).reduce(
				( acc, seg ) => acc + ( seg.size || 0 ),
				0
			);
			writeTotals.set( log.name, head );
		} );
	} );
	writeTotals.forEach( ( total, source ) => {
		const step = steppedRate( priorWrite[ source ], total, ts );
		nextWrite[ source ] = step;
		writeRates[ source ] = step.rate;
	} );

	// Read step per reader, computed ONCE up front (per-topology was N×M).
	const readStepByReader = new Map();
	consumers.forEach( ( row ) => {
		if ( readStepByReader.has( row.reader ) ) {
			return;
		}
		const live =
			liveByName.get( `${ row.source }#${ row.partition }` ) || [];
		const step = steppedRate(
			priorRead[ row.reader ],
			cursorBytes( live, row.cursor_segment, row.cursor_offset ),
			ts
		);
		readStepByReader.set( row.reader, step );
		nextRead[ row.reader ] = step;
	} );

	Object.entries( graph ).forEach( ( [ topology, graphTopo ] ) => {
		const handlers = consumerHandlers( graphTopo );

		// One worker per probe row; resolve handler by its reads-template.
		consumers.forEach( ( row ) => {
			// Match by READER (unique); fall back to source when no reader.
			const matching = handlers.filter( ( h ) =>
				h.readerTemplate
					? concreteSource(
							h.readerTemplate,
							row.partition,
							topology
					  ) === row.reader
					: concreteSource(
							h.sourceTemplate,
							row.partition,
							topology
					  ) === row.source
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
				byteRates[ `${ handler }-${ row.partition }-${ concrete }` ] =
					readStep.rate;
				workers.push( {
					type: topology,
					handler,
					source: concrete,
					partition: row.partition,
					status: status ? status.status : 'dead',
					live: status ? status.live : false,
					stale: status ? status.stale : false,
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
