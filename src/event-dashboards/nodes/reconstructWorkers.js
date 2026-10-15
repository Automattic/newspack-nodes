/**
 * Join the lean `dump_graph` payload into the rich `workers[]` array that
 * `topologyGraph.buildTopologySections`, `TreeEntity` and `SegmentBar` read.
 *
 * `Workers_CI::cmd_dump_graph` answers four unjoined views, because PHP does no
 * worker attribution; the browser walks the graph once per poll instead.
 *
 * - `graph` is the declared `.tsl` structure, one `{nodes,edges}` per topology.
 *   A `consumer` node carries `reads`, its source-log template, and `reader`,
 *   its offsetlog template. A broker carries `sources`; its readers are runtime
 *   children with no node of their own, so their rows hang under the broker.
 * - `workers` carries liveness alone, one row per (type, partition): its
 *   `state` (`CLI::worker_states()`'s word), heartbeat and start times.
 * - `consumers` carries each reader's probe state: its cursor, the partition
 *   end it recorded, how far behind that leaves it, and the bytes it read over
 *   the window its newest record covers.
 * - `logs` carries the live per-partition segment lists, each beside the
 *   growth window of its newest fresh Partition record, and `logs_at` the
 *   instant after their stat.
 *
 * A template still holds its `{partition}` and `<topology>` tokens, and
 * `topologyGraph.substituteTokens` is the one thing that resolves them, so a
 * match never parses a concrete name by position.
 *
 * `SegmentBar` receives the UNTRIMMED live segments plus each consumer's
 * recorded `(end_segment, end_size)` and derives its three regions from the two
 * together: what the reader has consumed, what it still owes, and what the
 * writer appended after the reader's last probe. Trimming the segments to the
 * recorded end here would erase that third region for every tree at once.
 */

import { workerId } from '@newspack-nodes/shared/utils/workerId';
import { Node } from '../../runtime/node';
import { remoteOf } from '../../runtime/log-stamp';
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
 * The id a broker's reader reports under on the probe log: its name,
 * `<broker>:<stamp>`, scoped by the topology and spelled as a worker id at the
 * partition. The twin of PHP `Remote_Broker_Node::reader_id()`, held to it by
 * `tests/fixtures/log-remotes.json`.
 *
 * @param {string} topology  The topology the broker sits in.
 * @param {string} broker    The broker's node name.
 * @param {string} stamp     The reader's stamp.
 * @param {number} partition The worker partition.
 * @return {string} The reader id.
 * @testonly Exported so the parity test can pin it to the PHP twin.
 */
export const brokerReaderId = ( topology, broker, stamp, partition ) =>
	workerId(
		`${ topology }.${ Node.siblingNameOf( broker, stamp ) }`,
		partition
	);

/**
 * Is a probe row one of a broker's readers?
 *
 * Its SOURCE names a spoke's log, `remote:<vault_id>:<stamp>`, and its reader
 * id is the one `brokerReaderId()` gives that stamp under this broker.
 *
 * @param {Object} row      A `consumers[]` probe row.
 * @param {string} topology The topology the broker sits in.
 * @param {string} broker   The broker's node name.
 * @return {boolean} True when the row is that broker's reader.
 */
const brokerReads = ( row, topology, broker ) => {
	const remote = remoteOf( row.source );
	return (
		null !== remote &&
		brokerReaderId( topology, broker, remote.stamp, row.partition ) ===
			row.reader
	);
};

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
 * directly, with no logic node between, falls back to its own name. A broker
 * yields an entry too, flagged `broker`, whose handler is itself.
 *
 * @param {Object} graphTopo One topology's `{ nodes:[{name,kind,reads?,reader?,sources?}], edges:[[from,to]] }`.
 * @return {Array<{name:string,broker?:boolean,sourceTemplate:string,readerTemplate:string,handlers:string[]}>} One entry
 *   per consumer node: its name, its source-log template, the offsetlog template that names its reader,
 *   and every handler its rows attach to. Both templates still carry their `{partition}`/`<topology>`
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
		if ( Array.isArray( node.sources ) ) {
			out.push( {
				name: node.name,
				broker: true,
				sourceTemplate: '',
				readerTemplate: '',
				handlers: [ node.name ],
			} );
			return;
		}
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
 * Bytes per second over a window the measuring node timed itself.
 *
 * Every rate here divides a probe's own window — never two positions
 * differenced over the poll clock, which divides a 15-second sweep's work by
 * however long the 5-second poll waited for it: after a hidden tab, a third
 * of the sweep and a threefold spike.
 *
 * @param {number} bytes     Bytes moved during the window.
 * @param {number} elapsedMs The window, in milliseconds.
 * @return {number} Bytes per second; 0 for a window covering no time.
 */
const perSecond = ( bytes, elapsedMs ) =>
	elapsedMs > 0 ? ( bytes * 1000 ) / elapsedMs : 0;

/**
 * Bytes a log grew between two segment lists: each surviving segment's gain
 * plus every new segment whole. A segment retention deleted is simply absent,
 * so it subtracts nothing, and one smaller than it was is a log wiped and
 * rewritten under a reused id, so it counts whole. The twin of
 * `Partition_Node::drain_growth_window()`.
 *
 * @param {Object<number,number>}          before Segment id to size, as last seen.
 * @param {Array<{id:number,size:number}>} after  The live segments now.
 * @return {number} Bytes grown.
 */
const grownBytes = ( before, after ) =>
	after.reduce( ( acc, seg ) => {
		const was = before[ seg.id ] ?? 0;
		return acc + ( seg.size < was ? seg.size : seg.size - was );
	}, 0 );

/**
 * The write rate of a log no worker probes, from its live segments against
 * the previous poll's, over the stat clock `logs_at` stamps after the stat.
 *
 * A poll carrying no clock measures nothing and keeps the old baseline, so
 * the next poll spans both. A clock no later than the baseline's is no span
 * either: it reads 0 and becomes the baseline.
 *
 * @param {{at:number,sizes:Object<number,number>}|undefined} prev     The previous poll's sample.
 * @param {Array<{id:number,size:number}>}                    segments The live segments now.
 * @param {number|undefined}                                  at       When they were stat'd, in seconds.
 * @return {{rate:number,next:({at:number,sizes:Object<number,number>}|undefined)}} The rate, and the sample to carry.
 */
function liveRate( prev, segments, at ) {
	if ( ! Number.isFinite( at ) ) {
		return { rate: 0, next: prev };
	}
	const next = {
		at,
		sizes: Object.fromEntries( segments.map( ( s ) => [ s.id, s.size ] ) ),
	};
	if ( ! prev || at <= prev.at ) {
		return { rate: 0, next };
	}
	return {
		rate: grownBytes( prev.sizes, segments ) / ( at - prev.at ),
		next,
	};
}

/**
 * Join the four lean inputs into the rich `workers[]` array plus the two rate
 * maps `globalRates` sums.
 *
 * Both rates divide ONE probe window: a reader's `bytes_read` over its
 * `elapsed_ms`, and a log's `probe`, the bytes it grew over its newest
 * Partition record's window. Neither needs the last poll. A log no worker
 * probes is the one exception, rated from its live segments against the
 * previous poll's, so the caller passes those samples and gets the next ones
 * back; the state stays in the transform node, and the join stays a plain
 * function a test can call twice. Every log's sample is carried, probed or
 * not, so a probe that lapses — a recycled prober's first window is too short
 * to stand — falls back to a baseline rather than reading 0. The `logs` come back untouched, so the
 * segment bar still sees the full live data.
 *
 * @param {Object} data      The `dump_graph` payload: `graph`, `workers`, `consumers`, `logs`, `logs_at`.
 * @param {Object} priorLive Previous poll's live samples, keyed by log-partition name.
 * @return {Object} `{ workers, logs, byteRates, writeRates, nextLive }` — the rich rows, the live logs,
 *   read rate per reader, write rate per log partition, and the live samples for the next poll.
 */
export function reconstructWorkers( data, priorLive ) {
	const graph = data.graph || {};
	const liveness = data.workers || [];
	const consumers = data.consumers || [];
	const logs = data.logs || [];

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
	const nextLive = {};

	logs.forEach( ( log ) => {
		( log.partitions || [] ).forEach( ( p ) => {
			const live = liveRate(
				priorLive[ log.name ],
				p.segments || [],
				data.logs_at
			);
			writeRates[ log.name ] = p.probe
				? perSecond( p.probe.grown, p.probe.elapsed_ms )
				: live.rate;
			if ( live.next ) {
				nextLive[ log.name ] = live.next;
			}
		} );
	} );

	consumers.forEach( ( row ) => {
		// @longform Key by READER, which is what a fleet-wide sum needs.
		// A handler key counts a reader fanning through a Tee once per
		// downstream handler, and a source key merges two topologies
		// reading that one source into a single last-write-wins entry.
		byteRates[ row.reader ] = perSecond( row.bytes_read, row.elapsed_ms );
	} );

	Object.entries( graph ).forEach( ( [ topology, graphTopo ] ) => {
		const handlers = consumerHandlers( graphTopo );

		// One worker per probe row; resolve handler by its reads-template.
		consumers.forEach( ( row ) => {
			// Match by READER (unique); fall back to source when no reader.
			const bindings = { partition: row.partition, topology };
			const matching = handlers.filter( ( h ) => {
				if ( h.broker ) {
					return brokerReads( row, topology, h.name );
				}
				return h.readerTemplate
					? substituteTokens( h.readerTemplate, bindings ) ===
							row.reader
					: substituteTokens( h.sourceTemplate, bindings ) ===
							row.source;
			} );
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
				'live' !== status?.state
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

			chosen.handlers.forEach( ( handler ) => {
				workers.push( {
					type: topology,
					handler,
					source: concrete,
					partition: row.partition,
					state: status ? status.state : 'down',
					restart_pending: status ? status.restart_pending : false,
					heartbeat_age: status ? status.heartbeat_age : null,
					started_at: status ? status.started_at : null,
					cursor_segment: row.cursor_segment,
					cursor_offset: row.cursor_offset,
					behind: row.distance,
					read_rate: byteRates[ row.reader ],
					inputs: [ concrete ],
					outputs: [],
					inputs_status: [ inputsStatus ],
					outputs_status: [],
				} );
			} );
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
				state: w.state,
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
		nextLive,
	};
}
