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
 * Join the four lean inputs into the rich `workers[]` array plus the
 * partition-keyed rate maps the downstream reads. Stateless: the caller passes
 * the prior-poll state and gets the next state back, so the node owns no join
 * logic.
 *
 * @param {Object} data  The lean dump_graph payload (`graph`, `workers`, `consumers`, `logs`, `timestamp`).
 * @param {Object} prior `{ cursorBytes, totalBytes, timestamp }` from the previous poll.
 * @return {Object} `{ workers, byteRates, writeRates, nextCursorBytes, nextTotalBytes }`.
 */
export function reconstructWorkers( data, prior ) {
	const graph = data.graph || {};
	const liveness = data.workers || [];
	const consumers = data.consumers || [];
	const logs = data.logs || [];
	const ts = data.timestamp;
	const dt =
		null !== prior.timestamp && undefined !== ts && ts > prior.timestamp
			? ts - prior.timestamp
			: 0;

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
	const nextCursorBytes = {};
	const nextTotalBytes = {};

	Object.entries( graph ).forEach( ( [ topology, graphTopo ] ) => {
		const handlers = consumerHandlers( graphTopo );

		// One rich worker per probe row (so disambiguated readers each get their
		// own row). Resolve each row's handler from the consumer node whose `reads`
		// template substitutes to the row's source; when several consumer nodes
		// share that template, prefer the one whose name is embedded in the
		// disambiguated reader id, else the first match.
		consumers.forEach( ( row ) => {
			const matching = handlers.filter(
				( h ) =>
					concreteSource( h.sourceTemplate, row.partition ) ===
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

				// read_rate: Δ(absolute cursor byte position)/Δt, keyed as the
				// downstream NodeRow reads it (`handler-partition-source`).
				const pos = cursorBytes(
					segments,
					row.cursor_seg,
					row.cursor_off
				);
				const prevPos = prior.cursorBytes[ row.reader ];
				const rateKey = `${ handler }-${ row.partition }-${ concrete }`;
				byteRates[ rateKey ] =
					dt > 0 && undefined !== prevPos && pos >= prevPos
						? ( pos - prevPos ) / dt
						: 0;
			} );

			// Per-reader cursor position (rate Δ baseline) + per-source write rate
			// — recorded ONCE per probe row (independent of the handler fan-out).
			const pos = cursorBytes( segments, row.cursor_seg, row.cursor_off );
			nextCursorBytes[ row.reader ] = pos;
			const liveTotal = live.reduce( ( a, s ) => a + s.size, 0 );
			nextTotalBytes[ concrete ] = liveTotal;
			const prevTotal = prior.totalBytes[ concrete ];
			writeRates[ concrete ] =
				dt > 0 && undefined !== prevTotal && liveTotal >= prevTotal
					? ( liveTotal - prevTotal ) / dt
					: 0;
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
		nextCursorBytes,
		nextTotalBytes,
	};
}
