/**
 * Pure builder: the `.tsl` graph (`dump_graph.graph`) supplies tree STRUCTURE;
 * worker rows + the logs catalog supply the STATUS overlay.
 *
 * Per topology, the raw graph collapses into a log-centric vertex graph: a
 * `consumer` node becomes its `reads` log, a `partition`/`topic`/`log` becomes
 * its `writes` log, a `tee` is contracted out, and a `logic` node stays itself.
 * Roots are in-degree-0 vertices; an alpha-DFS with a cycle guard yields the
 * tree. Collapse keys ONLY on the emitted `kind`/`reads`/`writes` fields —
 * never on node-name suffixes. Within any sibling list, convergent logic
 * siblings (same non-empty downstream set — even a shared log) join onto one
 * entity so the shared subtree is built once; a log repeats only across
 * different subtrees / generations, never for same-level siblings.
 */

// Partition/Consumer paths carry `<partition>`; a Topic's path template carries
// the deferred curly `{partition}` (left untouched by shell interpolation on
// purpose). A vertex carries at most one syntax — match whichever is present.
const PARTITION_TOKENS = [ '<partition>', '{partition}' ];
const partitionTokenIn = ( vertex ) =>
	PARTITION_TOKENS.find( ( t ) => vertex.includes( t ) ) ?? null;

/**
 * Concrete catalog entries a log VERTEX resolves to, with each match's partition
 * NUMBER, layout-agnostic and parse-free of position. `graph_for` emits the
 * writes/reads basename verbatim from the .tsl path arg, so a partitioned vertex
 * carries the literal `<partition>` token wherever it sits (`firehose.p<partition>`,
 * `<partition>-req`, …). A concrete catalog entry matches when the vertex's literal
 * text brackets it (pre…post) AND the substituted middle is a non-empty all-digits
 * string (the partition NUMBER). That digit check — not a position parse — is what
 * keeps a token-at-end vertex (`firehose.p<partition>`, pre `firehose.p`) from
 * grabbing a sibling `firehose.priority.p0` whose middle would be `riority.p0`. The
 * middle digits ARE the partition value (the substituted token VALUE). A token-free
 * vertex (a Log sink `digest.md`, a clean logical name) matches only its exact
 * catalog twin (partition 0); if nothing matches we fall back to the vertex itself
 * so the tree still shows the node.
 *
 * @param {string}   vertex       The graph log-vertex name.
 * @param {string[]} catalogNames All concrete catalog entry names.
 * @return {Array<{name:string,partition:number}>} Matches (partition-sorted), or [{name:vertex,partition:0}].
 */
function concreteLogNames( vertex, catalogNames ) {
	const token = partitionTokenIn( vertex );
	if ( null === token ) {
		return [ { name: vertex, partition: 0 } ];
	}
	// Degrade safely on a multi-token vertex (unrealistic): pre = before the
	// first token, post = after the last; the all-digits middle test then
	// simply won't match, which is acceptable.
	const tokenAt = vertex.indexOf( token );
	const lastTokenAt = vertex.lastIndexOf( token );
	const pre = vertex.slice( 0, tokenAt );
	const post = vertex.slice( lastTokenAt + token.length );
	const matches = [];
	catalogNames.forEach( ( name ) => {
		if (
			name.length < pre.length + post.length ||
			! name.startsWith( pre ) ||
			! name.endsWith( post )
		) {
			return;
		}
		const middle = name.slice( pre.length, name.length - post.length );
		if ( middle.length > 0 && /^\d+$/.test( middle ) ) {
			matches.push( { name, partition: Number( middle ) } );
		}
	} );
	if ( 0 === matches.length ) {
		return [ { name: vertex, partition: 0 } ];
	}
	return matches.sort( ( a, b ) => a.partition - b.partition );
}

/**
 * The LOGICAL display name for a log VERTEX: the `<partition>` token removed plus
 * one flanking separator cleaned. `firehose.p<partition>` → `firehose`,
 * `<partition>-req` → `req`, token-free `digest.md` → `digest.md`. Display-only
 * heuristic: a partition-bearing log renders as ONE logical entity, its concrete
 * partitions as sub-rows.
 *
 * @param {string} vertex The graph log-vertex name.
 * @return {string} The token-stripped logical name.
 */
function logicalLogName( vertex ) {
	const token = partitionTokenIn( vertex );
	if ( null === token ) {
		return vertex;
	}
	const tokenAt = vertex.indexOf( token );
	const lastTokenAt = vertex.lastIndexOf( token );
	const pre = vertex
		.slice( 0, tokenAt )
		// Drop a trailing `p` partition-prefix then a separator run (`firehose.p` → `firehose`).
		.replace( /[._-]p$/, '' );
	const post = vertex
		.slice( lastTokenAt + token.length )
		// Drop a leading separator run (`-req` → `req`).
		.replace( /^[._-]+/, '' );
	const name = pre + post;
	return '' !== name ? name : vertex;
}

const lc = ( s ) => String( s ).toLowerCase();
const byLower = ( a, b ) => {
	const x = lc( a );
	const y = lc( b );
	if ( x < y ) {
		return -1;
	}
	return x > y ? 1 : 0;
};

/**
 * Collapse workers into steps keyed by (type, handler, source).
 *
 * @param {Array} workers Worker descriptors.
 * @return {Array} Step descriptors with merged worker rows.
 */
function buildSteps( workers ) {
	const byKey = new Map();
	workers.forEach( ( wk ) => {
		const handler = wk.handler || wk.type;
		const source = wk.source || '';
		const key = `${ wk.type }|${ handler }|${ source }`;
		if ( ! byKey.has( key ) ) {
			byKey.set( key, {
				key,
				type: wk.type,
				handlerName: handler,
				source,
				inputs: Array.isArray( wk.inputs ) ? wk.inputs : [],
				outputs: Array.isArray( wk.outputs ) ? wk.outputs : [],
				workers: [],
			} );
		}
		byKey.get( key ).workers.push( wk );
	} );
	return [ ...byKey.values() ];
}

/**
 * Resolve a log's partition list + cursor flag. Ported from WorkerStatus.js's
 * `collectLogPartitions` (cursor-merge / canonical-slot / worker-data fallback);
 * the locals it closed over are read off `ctx` instead.
 *
 * @param {string} logName The log file name.
 * @param {Object} ctx     { stepByKey, producers, consumers, logSlotsByName }.
 * @return {Object} { partitions, hasCursor }.
 */
function collectLogPartitions( logName, ctx ) {
	const { stepByKey, producers, consumers, logSlotsByName } = ctx;
	const consumerKeys = consumers.get( logName ) || [];

	// Cursor data by partition from any worker reading this log.
	const cursorByPartition = new Map();
	let hasCursor = false;
	for ( const ckey of consumerKeys ) {
		const step = stepByKey.get( ckey );
		if ( ! step ) {
			continue;
		}
		step.workers.forEach( ( wk ) => {
			const entry = ( wk.inputs_status || [] ).find(
				( s ) => s && s.name === logName
			);
			if ( entry && entry.cursor_seg !== undefined ) {
				cursorByPartition.set( wk.partition, {
					cursor_seg: entry.cursor_seg,
					cursor_offset: entry.cursor_offset,
				} );
				hasCursor = true;
			}
		} );
	}

	const canonical = logSlotsByName.get( logName );
	if ( canonical && canonical.length > 0 ) {
		const partitions = canonical.map( ( slot ) => {
			const cursor = cursorByPartition.get( slot.partition );
			return cursor ? { ...slot, ...cursor } : slot;
		} );
		return { partitions, hasCursor };
	}

	// No canonical entry (dir not yet created) — fall back to worker data.
	const producerKeys = producers.get( logName ) || [];
	for ( const ckey of consumerKeys ) {
		const step = stepByKey.get( ckey );
		if ( ! step ) {
			continue;
		}
		const partitions = [];
		step.workers.forEach( ( wk ) => {
			const entry = ( wk.inputs_status || [] ).find(
				( s ) => s && s.name === logName
			);
			if ( entry ) {
				partitions.push( {
					partition: wk.partition,
					segments: entry.segments || [],
					total_size: entry.total_size || 0,
					cursor_seg: entry.cursor_seg,
					cursor_offset: entry.cursor_offset,
				} );
			}
		} );
		if ( partitions.length > 0 ) {
			return { partitions, hasCursor: true };
		}
	}
	for ( const pkey of producerKeys ) {
		const step = stepByKey.get( pkey );
		if ( ! step ) {
			continue;
		}
		const partitions = [];
		step.workers.forEach( ( wk ) => {
			const entry = ( wk.outputs_status || [] ).find(
				( s ) => s && s.name === logName
			);
			if ( entry ) {
				partitions.push( {
					partition: wk.partition,
					segments: entry.segments || [],
					total_size: entry.total_size || 0,
				} );
			}
		} );
		if ( partitions.length > 0 ) {
			return { partitions, hasCursor: false };
		}
	}

	return { partitions: [], hasCursor: false };
}

/**
 * Collapse one topology's raw `.tsl` graph into a log-centric vertex graph.
 *
 * Maps each node to a vertex (consumer→reads log, partition/topic/log→writes
 * log, logic→itself), contracts every tee (in×out → direct edges) until none remain,
 * then resolves endpoints, drops self-loops, and dedups edges.
 *
 * @param {Object} graphTopo `{ nodes:[{name,kind,reads?,writes?}], edges:[[from,to]] }`.
 * @return {Object} `{ outAdj, inDegree, isLog }` over the vertex set.
 */
function collapseGraph( graphTopo ) {
	const nodes = Array.isArray( graphTopo?.nodes ) ? graphTopo.nodes : [];
	const rawEdges = Array.isArray( graphTopo?.edges ) ? graphTopo.edges : [];

	const logVertexOf = ( n ) => {
		if ( 'consumer' === n.kind ) {
			return n.reads;
		}
		if (
			'partition' === n.kind ||
			'topic' === n.kind ||
			'log' === n.kind
		) {
			return n.writes;
		}
		return n.name;
	};

	const isTee = new Set();
	const vertexOf = new Map();
	const isLog = new Map();
	nodes.forEach( ( n ) => {
		if ( 'tee' === n.kind ) {
			isTee.add( n.name );
			return;
		}
		const vertex = logVertexOf( n );
		if ( ! vertex ) {
			return;
		}
		vertexOf.set( n.name, vertex );
		isLog.set( vertex, 'logic' !== n.kind );
	} );

	// Contract tees: replace x→T, T→y with x→y until no edge touches a tee.
	let edges = rawEdges.map( ( e ) => [ e[ 0 ], e[ 1 ] ] );
	while ( edges.some( ( [ a, b ] ) => isTee.has( a ) || isTee.has( b ) ) ) {
		const tee = edges
			.flatMap( ( [ a, b ] ) => [ a, b ] )
			.find( ( name ) => isTee.has( name ) );
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
	const inDegree = new Map();
	const ensure = ( v ) => {
		if ( ! outAdj.has( v ) ) {
			outAdj.set( v, new Set() );
		}
		if ( ! inDegree.has( v ) ) {
			inDegree.set( v, 0 );
		}
	};
	[ ...vertexOf.values() ].forEach( ensure );

	const seenEdge = new Set();
	edges.forEach( ( [ a, b ] ) => {
		const from = vertexOf.get( a );
		const to = vertexOf.get( b );
		if ( ! from || ! to || from === to ) {
			return;
		}
		const sig = `${ from }${ to }`;
		if ( seenEdge.has( sig ) ) {
			return;
		}
		seenEdge.add( sig );
		ensure( from );
		ensure( to );
		outAdj.get( from ).add( to );
		inDegree.set( to, inDegree.get( to ) + 1 );
	} );

	return { outAdj, inDegree, isLog };
}

/**
 * Build one node/log tree section per topology.
 *
 * @param {Object} graph       `dump_graph.graph` keyed by topology.
 * @param {Array}  workers     Worker descriptors (status overlay).
 * @param {Array}  logsCatalog Top-level `logs` array (canonical per-log slots).
 * @return {Array} Sections `[{ topology, workers, tree }]`, alpha-sorted by topology.
 */
export function buildTopologySections( graph, workers, logsCatalog = [] ) {
	const logSlotsByName = new Map();
	const logSegmentSizeByName = new Map();
	( logsCatalog || [] ).forEach( ( log ) => {
		logSlotsByName.set( log.name, log.partitions || [] );
		if ( log.segment_size ) {
			logSegmentSizeByName.set( log.name, log.segment_size );
		}
	} );

	const byType = new Map();
	( workers || [] ).forEach( ( wk ) => {
		if ( ! byType.has( wk.type ) ) {
			byType.set( wk.type, [] );
		}
		byType.get( wk.type ).push( wk );
	} );

	const sections = [];
	for ( const [ topology, graphTopo ] of Object.entries( graph || {} ) ) {
		const tWorkers = byType.get( topology ) || [];
		const { outAdj, inDegree, isLog } = collapseGraph( graphTopo );

		// Status-overlay context: worker rows keyed for collectLogPartitions.
		const steps = buildSteps( tWorkers );
		const stepByKey = new Map( steps.map( ( s ) => [ s.key, s ] ) );
		const producers = new Map();
		const consumers = new Map();
		steps.forEach( ( s ) => {
			s.outputs.forEach( ( n ) => {
				if ( ! producers.has( n ) ) {
					producers.set( n, [] );
				}
				producers.get( n ).push( s.key );
			} );
			s.inputs.forEach( ( n ) => {
				if ( ! consumers.has( n ) ) {
					consumers.set( n, [] );
				}
				consumers.get( n ).push( s.key );
			} );
		} );
		const ctx = { stepByKey, producers, consumers, logSlotsByName };
		const workersByHandler = new Map();
		tWorkers.forEach( ( wk ) => {
			const handler = wk.handler || wk.type;
			if ( ! workersByHandler.has( handler ) ) {
				workersByHandler.set( handler, [] );
			}
			workersByHandler.get( handler ).push( wk );
		} );

		const catalogNames = [ ...logSlotsByName.keys() ];
		const childrenOf = ( vertex ) =>
			[ ...( outAdj.get( vertex ) || [] ) ].sort( byLower );
		const makeVertex = ( vertex, path, prefix ) =>
			isLog.get( vertex )
				? makeLog( vertex, path, prefix )
				: makeNode( vertex, path, prefix );
		const makeKids = ( vertex, path, parentKey ) => {
			if ( path.has( vertex ) ) {
				return [];
			}
			return makeSiblings(
				childrenOf( vertex ),
				new Set( path ).add( vertex ),
				parentKey
			);
		};

		// Out-neighbor signature; convergent siblings share the same downstream set.
		const signatureOf = ( vertex ) =>
			JSON.stringify( [ ...( outAdj.get( vertex ) || [] ) ].sort() );

		// Join logic siblings that converge on the same non-empty shared subtree —
		// including when that shared child is a LOG. Siblings here are a group with an
		// identical out-neighbor signature under one parent (same generation), so they
		// collapse to a single entity even when they all write to one log (e.g. three
		// sources → one ingest log). The repeat-per-writer rule is only for producers in
		// DIFFERENT subtrees (different parents / generations), which never land in the
		// same sibling group. Leaves (empty downstream) have nothing to deduplicate.
		const joinable = ( members ) => {
			if ( members.length < 2 ) {
				return false;
			}
			const shared = childrenOf( members[ 0 ] );
			return (
				shared.length > 0 && members.every( ( v ) => ! isLog.get( v ) )
			);
		};

		// Emit a sibling list, joining convergent logic-only groups (size >= 2)
		// onto one entity whose shared subtree is built once. `prefix` is the
		// parent entity's key; each child key is `${prefix}>${childVertexId}`
		// so a vertex reached via N parents gets N distinct (position) keys.
		const makeSiblings = ( siblings, path, prefix = '' ) => {
			const groups = new Map();
			siblings.forEach( ( vertex ) => {
				const groupKey = `${ isLog.get( vertex ) }|${ signatureOf(
					vertex
				) }`;
				if ( ! groups.has( groupKey ) ) {
					groups.set( groupKey, [] );
				}
				groups.get( groupKey ).push( vertex );
			} );
			const entities = [];
			groups.forEach( ( members ) => {
				if ( joinable( members ) ) {
					entities.push( makeJoinedNode( members, path, prefix ) );
				} else {
					members.forEach( ( v ) =>
						entities.push( makeVertex( v, path, prefix ) )
					);
				}
			} );
			return entities.sort( byName );
		};
		// A position key encodes the tree path: roots use their vertex id, a child
		// uses `${parentKey}>${childVertexId}`. Roots pass prefix ''.
		const childKey = ( prefix, id ) =>
			prefix ? `${ prefix }>${ id }` : id;
		const byName = ( a, b ) => byLower( a.name, b.name );
		const makeNode = ( vertex, path, prefix ) => {
			const key = childKey( prefix, vertex );
			return {
				kind: 'node',
				name: vertex,
				key,
				workers: workersByHandler.get( vertex ) || [],
				children: makeKids( vertex, path, key ),
			};
		};
		const makeJoinedNode = ( members, path, prefix ) => {
			const ids = [ ...members ].sort();
			const nextPath = new Set( path );
			ids.forEach( ( id ) => nextPath.add( id ) );
			const key = childKey( prefix, ids.join( '+' ) );
			return {
				kind: 'node',
				names: ids,
				name: ids.join( ', ' ),
				key,
				workers: ids.flatMap(
					( id ) => workersByHandler.get( id ) || []
				),
				children: makeSiblings( childrenOf( ids[ 0 ] ), nextPath, key ),
			};
		};
		// A log vertex GROUPS its concrete per-partition catalog entries into ONE
		// logical entity (`firehose`), each concrete entry becoming a partition
		// sub-row carried on the entity, with the downstream consumer subtree built
		// ONCE under that single entity (its position key per ancestry). Each
		// concrete entry's slot is stat'd via `collectLogPartitions` (catalog +
		// cursor merge) and stamped with its real partition number (the substituted
		// `<partition>` VALUE) so the partition-keyed rates line up.
		const makeLog = ( vertex, path, prefix ) => {
			const concretes = concreteLogNames( vertex, catalogNames );
			const name = logicalLogName( vertex );
			let hasCursor = false;
			const partitions = concretes.map(
				( { name: concrete, partition } ) => {
					const collected = collectLogPartitions( concrete, ctx );
					hasCursor = hasCursor || collected.hasCursor;
					const slot = collected.partitions[ 0 ] || {};
					// Carry the CONCRETE catalog name as the rate key: it's the
					// verbatim string the transform (recordLog) keys on too, so the
					// W/R rate + segment animations line up regardless of where the
					// partition token sits (layout-agnostic).
					return { ...slot, partition, name: concrete };
				}
			);
			const segmentSizeName = concretes.find( ( c ) =>
				logSegmentSizeByName.has( c.name )
			);
			const key = childKey( prefix, name );
			return {
				kind: 'log',
				name,
				key,
				partitions,
				hasCursor,
				segment_size: segmentSizeName
					? logSegmentSizeByName.get( segmentSizeName.name )
					: undefined,
				children: makeKids( vertex, path, key ),
			};
		};

		const rootVertices = [ ...inDegree.keys() ].filter(
			( v ) => 0 === inDegree.get( v )
		);
		const roots = makeSiblings( rootVertices, new Set(), '' );
		sections.push( { topology, workers: tWorkers, tree: roots } );
	}
	sections.sort( ( a, b ) => byLower( a.topology, b.topology ) );
	return sections;
}
