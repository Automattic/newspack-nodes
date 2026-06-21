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
 * The point of the trim (see `trimToSnapshot`): the live partition is usually
 * LARGER than the probe's snapshot, so each consumer's `inputs_status` is the
 * live segments clipped back to (end_seg, end_size) — the bar must reflect the
 * probe instant, not the now-grown partition.
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

/**
 * Trim a live partition's segments back to the probe snapshot: drop any segment
 * past `end_seg`, and cap the `end_seg` segment's size at `end_size`. Returns
 * the trimmed segments plus their recomputed total.
 *
 * @param {Array}  segments Live `{id,size,mtime?}` segments for the partition.
 * @param {number} endSeg   Last segment id at the snapshot instant.
 * @param {number} endSize  Size of the last segment at the snapshot instant.
 * @return {{segments:Array,total:number}} Trimmed segments + recomputed total.
 */
function trimToSnapshot( segments, endSeg, endSize ) {
	const trimmed = [];
	let total = 0;
	segments.forEach( ( seg ) => {
		if ( seg.id > endSeg ) {
			return;
		}
		const size =
			seg.id === endSeg ? Math.min( seg.size, endSize ) : seg.size;
		trimmed.push( { ...seg, size } );
		total += size;
	} );
	trimmed.sort( ( a, b ) => a.id - b.id );
	return { segments: trimmed, total };
}

// Absolute byte position of a cursor within its TRIMMED partition: the sum of
// every segment fully behind the cursor plus the offset into the current one.
const cursorBytes = ( segments, cursorSeg, cursorOff ) =>
	segments.reduce(
		( acc, seg ) => ( seg.id < cursorSeg ? acc + seg.size : acc ),
		0
	) + cursorOff;

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
 * join logic. Rates are PROBE-cadence (see `steppedRate`) — only the segment
 * lists use live data (and only trimmed to the snapshot).
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

	// Each partition's snapshot END, from the consumer reading it (`source#partition`
	// → {end_seg,end_size}). The dashboard's segment bar renders the canonical
	// `logs[]` (live), so to honor the probe snapshot we TRIM those live segments
	// here — not just the (discarded) per-worker inputs_status — clipping each
	// partition back to its reader's (end_seg,end_size). A partition with no reader
	// (a pure output log) keeps its live segments (no snapshot to clip to).
	const endByKey = new Map();
	consumers.forEach( ( row ) =>
		endByKey.set( `${ row.source }#${ row.partition }`, {
			endSeg: row.end_seg,
			endSize: row.end_size,
		} )
	);
	const trimmedLogs = logs.map( ( log ) => ( {
		...log,
		partitions: ( log.partitions || [] ).map( ( p ) => {
			const end = endByKey.get( `${ log.name }#${ p.partition }` );
			if ( ! end ) {
				return p;
			}
			const { segments, total } = trimToSnapshot(
				p.segments || [],
				end.endSeg,
				end.endSize
			);
			return { ...p, segments, total_size: total };
		} ),
	} ) );

	const workers = [];
	const byteRates = {};
	const writeRates = {};
	const nextRead = {};
	const nextWrite = {};

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
					String( row.reader ).includes( h.name )
				) || matching[ 0 ];
			const concrete = row.source;

			const live =
				liveByName.get( `${ concrete }#${ row.partition }` ) || [];
			const { segments, total } = trimToSnapshot(
				live,
				row.end_seg,
				row.end_size
			);
			const status = liveByKey.get( `${ topology }#${ row.partition }` );

			// One worker row PER downstream handler so a fanned-out consumer
			// (firehose → request-builder AND job-router) lands a row on EACH
			// processor's collapsed-graph vertex, exactly as the old one-row-per-
			// target data did. They share the reader's cursor/behind/segments.
			const inputsStatus = {
				name: concrete,
				partition: row.partition,
				segments,
				total_size: total,
				cursor_seg: row.cursor_seg,
				cursor_offset: row.cursor_off,
			};
			chosen.handlers.forEach( ( handler ) => {
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
					cursor_seg: row.cursor_seg,
					cursor_offset: row.cursor_off,
					behind: row.distance,
					inputs: [ concrete ],
					outputs: [],
					inputs_status: [ inputsStatus ],
					outputs_status: [],
				} );
			} );

			// Rates are PROBE-cadence (steppedRate), computed ONCE per probe row.
			// READ = Δ(cursor byte position within the snapshot partition); WRITE =
			// Δ(partition END position) where `total` (the trimmed segment sum) IS
			// the end position — both snapshot-stable, so they update only when new
			// probe data advances the cursor / end, never on the ~1s poll.
			const readStep = steppedRate(
				priorRead[ row.reader ],
				cursorBytes( segments, row.cursor_seg, row.cursor_off ),
				ts
			);
			nextRead[ row.reader ] = readStep;
			chosen.handlers.forEach( ( handler ) => {
				byteRates[ `${ handler }-${ row.partition }-${ concrete }` ] =
					readStep.rate;
			} );

			const writeStep = steppedRate( priorWrite[ concrete ], total, ts );
			nextWrite[ concrete ] = writeStep;
			writeRates[ concrete ] = writeStep.rate;
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
				cursor_seg: undefined,
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
		logs: trimmedLogs,
		byteRates,
		writeRates,
		nextRead,
		nextWrite,
	};
}
