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

// Substitute the partition number into a `<partition>` template. A token-free
// template (a clean logical name) is returned verbatim.
const concreteSource = ( template, partition ) =>
	template.includes( PARTITION_TOKEN )
		? template.split( PARTITION_TOKEN ).join( String( partition ) )
		: template;

// True when `reader` IS handler `name` — exactly, or `name` followed by a
// partition suffix at a separator boundary (`prereq.p0`, `prereq-0`). Anchored so
// `req` does NOT claim `prereq.p0` (the loose-substring bug): a substring hit must
// align with the start AND end at a separator, never mid-token.
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
 * vertex gets its own worker row (matching the old one-row-per-target data) —
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

	// Contract tees: replace x→T, T→y with x→y until no edge touches a tee
	// (the same loop as topologyGraph.collapseGraph, on raw node names).
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
		// EVERY downstream LOGIC node (the tee fan-out, post-contraction) — only
		// `logic` nodes become their own NodeRow vertex in collapseGraph (storage
		// kinds collapse to their writes-vertex), so only they are valid handlers.
		// A consumer feeding only storage directly (single-stage) → its own name.
		const downstream = ( outAdj.get( node.name ) || [] ).filter(
			( n ) => 'logic' === kindOf.get( n )
		);
		out.push( {
			name: node.name,
			sourceTemplate: node.reads || '',
			// The consumer's offsetlog basename template — its UNIQUE reader id.
			// Two topologies can read the same source via distinct offsetlogs, so
			// match probe rows by reader (when known), not just source.
			readerTemplate: node.reader || '',
			handlers: downstream.length > 0 ? downstream : [ node.name ],
		} );
	} );
	return out;
}

// Sum of every live segment's size — the partition's full size on disk.
const liveTotal = ( segments ) =>
	segments.reduce( ( acc, seg ) => acc + ( seg.size || 0 ), 0 );

// Absolute byte position of a cursor within its partition: the sum of every
// segment fully behind the cursor plus the offset into the current one.
const cursorBytes = ( segments, cursorSegment, cursorOffset ) =>
	segments.reduce(
		( acc, seg ) => ( seg.id < cursorSegment ? acc + seg.size : acc ),
		0
	) + cursorOffset;

// Absolute byte position of a partition's HEAD as the consumer knows it: full
// segments below `endSegment` plus the fresh `endSize` offset. Mirrors `cursorBytes`
// and, crucially, does NOT cap `endSize` at the live head-segment's size — that
// segment size is sampled separately and often lags `endSize`, which stuck the
// write rate at 0 while the read rate (fresh cursor offset) advanced. Used only
// for the write RATE.
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
		return { value, ts: prev.ts, rate: prev.rate }; // unchanged probe data → hold
	}
	return { value, ts: now, rate: prev.rate }; // went backward → rebaseline, hold rate
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

	// Live per-(name, partition) segment lists, indexed by concrete source name.
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

	// Write rate = Δ(probe END) of a partition — snapshot-stable, intentionally NOT
	// the live total. A partition can be read by SEVERAL consumers (distinct
	// topologies/readers) whose end snapshots differ and whose row order in
	// `consumers[]` is unstable across polls; collapse them per concrete source to
	// the MAX end (the reader closest to the head) so steppedRate sees ONE
	// monotonic series. Keying per-row by source instead (the old bug) let the two
	// readers clobber each other non-monotonically and stranded fanned partitions
	// at 0 B/s. Computed once here, reader-count- and order-independent.
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
	// OUTPUT logs (written but read by nothing in the graph) have no consumer row,
	// so fall back to the live segment head — else a busy output partition shows
	// W 0 B/s forever. A CONSUMED log keeps its reader's END (set above): that is
	// intentionally NOT the live total, so only fill keys not already present.
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

	// Read step per reader, computed ONCE up front: it depends only on the probe
	// row (reader / source / cursor) + the live segments + ts — never the topology.
	// Computing it inside the per-topology loop made it N×M (most discarded). One
	// reader's cursor advances at one rate no matter how many topologies read it.
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

		// One rich worker per probe row (so disambiguated readers each get their
		// own row). Resolve each row's handler from the consumer node whose `reads`
		// template substitutes to the row's source; when several consumer nodes
		// share that template, prefer the one whose name is embedded in the
		// disambiguated reader id, else the first match.
		consumers.forEach( ( row ) => {
			// Match by the consumer's READER (its offsetlog) when known — that's
			// the unique key, so two topologies sharing a source don't both claim
			// the other's probe row. Fall back to source for consumers whose graph
			// node carries no reader template (single-reader sources, unchanged).
			const matching = handlers.filter( ( h ) =>
				h.readerTemplate
					? concreteSource( h.readerTemplate, row.partition ) ===
					  row.reader
					: concreteSource( h.sourceTemplate, row.partition ) ===
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

			// Drop a ghost reader: a stale probe row for a partition that's no
			// longer declared (config shrank the count away) AND has no live worker
			// backing it. liveByName is the declared-log set already in context, so
			// this cross-checks against the real source — not just a stall timer.
			// A still-declared partition (between worker respawns) stays visible.
			if (
				! liveByName.has( `${ concrete }#${ row.partition }` ) &&
				! ( status && status.live )
			) {
				return;
			}

			// One worker row PER downstream handler so a fanned-out consumer
			// (firehose → request-builder AND job-router) lands a row on EACH
			// processor's collapsed-graph vertex, exactly as the old one-row-per-
			// target data did. They share the reader's cursor/end/segments. The bar
			// carries the FULL live segments plus the reader's recorded (end_segment,
			// end_size) so it can paint the green/red/gray regions itself.
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

			// Read rate is PROBE-cadence (steppedRate), computed ONCE per reader up
			// front (see readStepByReader) — NOT here per topology, which recomputed
			// the identical step N times. Each worker carries its own read_rate (for
			// the ETA rollup + the eta-aware "behind" health).
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
			// Write rate is computed once per source up front (see maxEndBySource) —
			// NOT here per consumer row, which clobbered fanned partitions.
		} );

		// A liveness row with no matching consumer row still emits a worker so the
		// tree shows the worker. Track which (type, partition) already produced a
		// row above and backfill the rest from liveness.
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
