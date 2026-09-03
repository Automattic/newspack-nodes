/**
 * Builds the entity tree a topology's dashboard section draws.
 *
 * The `.tsl` graph (`dump_graph.graph`) supplies the tree STRUCTURE, and the
 * worker rows plus the logs catalog supply the STATUS overlay. Every function
 * here is pure, so a view node rebuilds the whole tree from each snapshot and
 * holds no state of its own.
 *
 * Per topology the raw graph collapses into a log-centric vertex graph: a
 * `consumer` node becomes its `reads` log, a `partition`, `topic` or `log`
 * node becomes its `writes` log, a `tee` is contracted out, and a `logic` node
 * stays itself. Roots are the in-degree-0 vertices, and a depth-first walk
 * with a cycle guard yields the tree, every sibling list alphabetical.
 *
 * The collapse keys ONLY on the emitted `kind`/`reads`/`writes` fields, never
 * on a node-name suffix, so what a topology author calls a node cannot change
 * the shape of the tree. Within a sibling list, convergent logic siblings —
 * those sharing one non-empty downstream set, a shared log included — join
 * onto a single entity, so the subtree below them is built once. A log
 * therefore repeats across branches and generations, never within one sibling
 * list.
 */

/**
 * Both spellings a partition token takes in a `.tsl` path.
 *
 * A Consumer's path argument carries `<partition>`, while a Topic names its
 * own partitions with `{partition}`. Both reach the dashboard verbatim, so
 * every reader here matches either.
 */
const PARTITION_TOKENS = [ '<partition>', '{partition}' ];

/** The fleet-name token a reader's offsetlog path carries. */
const TOPOLOGY_TOKEN = '<topology>';

/**
 * The partition token a vertex carries, or null when it carries none.
 *
 * @param {string} vertex A graph vertex name or path template.
 * @return {?string} The token found, in `PARTITION_TOKENS` order.
 */
const partitionTokenIn = ( vertex ) =>
	PARTITION_TOKENS.find( ( t ) => vertex.includes( t ) ) ?? null;

/**
 * Bind a `.tsl` path template the way `Topology_Loader` does: every partition
 * token, plus `<topology>` when a fleet name is supplied.
 *
 * ONE substituter over ONE token list. An offsetlog is a reader's cursor and
 * the reader is the FLEET, so a reader template carries `<topology>` too:
 * binding the partition alone leaves `firehose.<topology>.p0`, which matches
 * no live `firehose.combined.p0` and costs every segment bar its cursor.
 *
 * @param {string}        template            Path template.
 * @param {Object}        bindings            What to bind.
 * @param {number|string} bindings.partition  Partition index.
 * @param {string}        [bindings.topology] Fleet name; omitted leaves the token.
 * @return {string} The concrete path.
 */
export function substituteTokens( template, { partition, topology } ) {
	let out = String( template );
	PARTITION_TOKENS.forEach( ( token ) => {
		out = out.split( token ).join( String( partition ) );
	} );
	if ( topology ) {
		out = out.split( TOPOLOGY_TOKEN ).join( String( topology ) );
	}
	return out;
}

/**
 * The concrete catalog entries a log VERTEX resolves to, each with its
 * partition NUMBER.
 *
 * `Topology_Analyzer::graph_for` emits the `reads`/`writes` basename verbatim
 * from the `.tsl` path argument, so a partitioned vertex carries the literal
 * partition token wherever the author put it: `firehose.p<partition>`,
 * `<partition>-req`, and anything else. A catalog entry matches when the text
 * on either side of the token brackets it AND the middle it substitutes for is
 * a non-empty run of digits, which is the partition number itself.
 *
 * The digit test, rather than a parse of the token's position, is what keeps
 * `firehose.p<partition>` from claiming a sibling `firehose.priority.p0`,
 * whose middle would read `riority.p0`. It also keeps the reader free of any
 * `.p{N}` assumption: the layout lives in the `.tsl` path, never here.
 *
 * A token-free vertex — a `Log` sink such as `digest.md` — is already its own
 * concrete name, so it resolves against the entry spelled exactly that and
 * never a near neighbour like `digest.markdown`. When nothing matches, the
 * vertex stands in for itself so the tree still draws the log.
 *
 * @param {string}   vertex       The graph log-vertex name.
 * @param {string[]} catalogNames All concrete catalog entry names.
 * @return {Array<{name:string,partition:number}>} The matches, partition-ordered, or the vertex itself at partition 0.
 */
function concreteLogNames( vertex, catalogNames ) {
	const token = partitionTokenIn( vertex );
	if ( null === token ) {
		return [ { name: vertex, partition: 0 } ];
	}
	// A multi-token vertex brackets on its first and its last token.
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
 * The LOGICAL display name of a log VERTEX: the partition token removed, along
 * with the separator flanking it.
 *
 * `firehose.p<partition>` reads as `firehose`, `<partition>-req` as `req`, and
 * a token-free `digest.md` as itself. A partition-bearing log draws as ONE
 * entity with its concrete partitions as sub-rows, and this is that entity's
 * name — display only, never a key anything resolves by. Stripping everything
 * would leave an unnamed row, so a vertex made entirely of token and
 * separators keeps its literal text.
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
		// Drop a trailing `p` + separator (`firehose.p` → `firehose`).
		.replace( /[._-]p$/, '' );
	const post = vertex
		.slice( lastTokenAt + token.length )
		// Drop a leading separator run (`-req` → `req`).
		.replace( /^[._-]+/, '' );
	const name = pre + post;
	return '' !== name ? name : vertex;
}

/**
 * Bind a graph log vertex to one worker's partition.
 *
 * A worker row names the concrete log it probes, while the branch above it
 * keeps the tokenized `.tsl` vertex; binding the vertex is what lets the two
 * be compared.
 *
 * @param {string}        vertex    The tokenized log vertex.
 * @param {number|string} partition The worker's partition index.
 * @return {string} The concrete log name.
 */
const concreteLogForPartition = ( vertex, partition ) =>
	substituteTokens( vertex, { partition } );

/**
 * Contract every `tee` out of an edge list, so each pair of edges through a
 * tee becomes one direct edge, repeated until no edge touches a tee.
 *
 * A Tee is fan-out plumbing rather than work a reader tracks, so the tree
 * draws what a branch actually feeds. Both readers of a `.tsl` graph have to
 * land on the same collapsed vertices — `collapseGraph` renders them and
 * `reconstructWorkers.consumerHandlers` attributes worker rows to them — so
 * the rewrite has ONE implementation.
 *
 * @param {Array<Array<string>>}        rawEdges `[ from, to ]` pairs; never mutated.
 * @param {( name: string ) => boolean} isTee    True for a tee vertex.
 * @return {Array<Array<string>>} The contracted edge list.
 */
export function contractTees( rawEdges, isTee ) {
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
	return edges;
}

/**
 * The lowercase form of a name, for case-insensitive ordering.
 *
 * @param {string} s The name to fold.
 * @return {string} Its lowercase form.
 */
const lc = ( s ) => String( s ).toLowerCase();

/**
 * Order two names case-insensitively, so a sibling list reads alphabetically
 * whatever case a topology file spells each node in.
 *
 * @param {string} a The first name.
 * @param {string} b The second name.
 * @return {number} The comparison `Array.prototype.sort` wants.
 */
const byLower = ( a, b ) => {
	const x = lc( a );
	const y = lc( b );
	if ( x < y ) {
		return -1;
	}
	return x > y ? 1 : 0;
};

/**
 * Collapse worker rows into steps keyed by type, handler and source.
 *
 * The key omits the partition, so every partition of one handler reading one
 * source lands in a single step. `collectLogPartitions` reads a step's rows
 * for the cursor of each partition, and its fallback tiers return the first
 * step that yields any: keyed per partition, a log would show one partition
 * and drop the rest. A step takes its `inputs` and `outputs` from the first
 * row of its key, which names the same source log as every other row there.
 *
 * @param {Array<Object>} workers Worker descriptors.
 * @return {Array<Object>} One step per key, each carrying its worker rows.
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
 * Resolve one log's partition slots, and whether a reader's cursor rides along.
 *
 * Three tiers, in order. The canonical catalog slots win, each merged with the
 * cursor and recorded end that this topology's own consumer probed. A log with
 * no catalog entry falls back to the consuming workers' `inputs_status`, which
 * is what a partition directory that does not exist yet looks like. A log
 * nothing reads falls back to the producing workers' `outputs_status`, which
 * carries segments but no cursor.
 *
 * Only THIS topology's workers are read, because two topologies reading one
 * log sit at different cursors; merging them would drag both segment bars to
 * whichever one renders last.
 *
 * @param {string} logName The concrete log name.
 * @param {Object} ctx     `{ stepByKey, producers, consumers, logSlotsByName }`, built by `buildTopologySections`.
 * @return {{partitions:Array<Object>,hasCursor:boolean}} The slots, and true when one carries a cursor.
 */
function collectLogPartitions( logName, ctx ) {
	const { stepByKey, producers, consumers, logSlotsByName } = ctx;
	const consumerKeys = consumers.get( logName ) || [];

	// Cursor and probe end per partition, from THIS topology's worker.
	const probeByPartition = new Map();
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
			if ( entry && entry.cursor_segment !== undefined ) {
				probeByPartition.set( wk.partition, {
					cursor_segment: entry.cursor_segment,
					cursor_offset: entry.cursor_offset,
					end_segment: entry.end_segment,
					end_size: entry.end_size,
				} );
				hasCursor = true;
			}
		} );
	}

	const canonical = logSlotsByName.get( logName );
	if ( canonical && canonical.length > 0 ) {
		const partitions = canonical.map( ( slot ) => {
			const probe = probeByPartition.get( slot.partition );
			return probe ? { ...slot, ...probe } : slot;
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
					cursor_segment: entry.cursor_segment,
					cursor_offset: entry.cursor_offset,
					end_segment: entry.end_segment,
					end_size: entry.end_size,
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
 * A `consumer` maps to the log it reads, a `partition`, `topic` or `log` to
 * the log it writes, and every other node to itself; a `tee` contracts out.
 * Distinct nodes therefore share a vertex whenever they name one log, which is
 * what draws two writers of `jobs.log` as one branch instead of two.
 *
 * Endpoints resolve after the contraction, then self-loops drop and duplicate
 * edges collapse. A direct edge from a log's reader to its writer would
 * otherwise leave that vertex pointing at itself, taking its in-degree-0 root
 * status with it and leaving the topology with no root to draw.
 *
 * A node that names no log — a `consumer` with an empty `reads` — has no
 * vertex, so it and every edge touching it drop out with it.
 *
 * @param {Object} graphTopo `{ nodes:[{name,kind,reads?,writes?}], edges:[[from,to]] }`.
 * @return {{outAdj:Map<string,Set<string>>,inDegree:Map<string,number>,isLog:Map<string,boolean>}} The vertex
 *   set: out-neighbours, in-degree, and whether each vertex is a log rather than a logic node.
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

	const edges = contractTees( rawEdges, ( name ) => isTee.has( name ) );

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
 * A section carries its topology's own worker rows and a `tree` of entities.
 * A `node` entity holds the rows of the branch that reaches it; a `log` entity
 * holds one row per concrete partition, the segment size those rows scale to,
 * and whether a reader's cursor rides along. Every entity carries a
 * topology-scoped `key` the dashboards fold on, and a `children` array.
 *
 * @param {Object}        graph         `dump_graph.graph`, keyed by topology.
 * @param {Array<Object>} workers       Worker descriptors: the status overlay.
 * @param {Array<Object>} [logsCatalog] The top-level `logs` array, holding the canonical per-log slots.
 * @return {Array<{topology:string,workers:Array<Object>,tree:Array<Object>}>} One section per topology, alphabetical.
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

		// Index the worker rows the way collectLogPartitions reads them.
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
		/**
		 * The worker rows this branch's handler owns.
		 *
		 * A handler fed by two logs — a `job-router` reading both `firehose` and
		 * `jobintake` — carries one row per source, and each row belongs under the
		 * log that feeds it. The nearest log ancestor on the path, bound to the
		 * row's own partition, is that test. A row naming no source stays on every
		 * branch, as does every row when no log sits above the handler at all.
		 *
		 * @param {string}      handler The vertex name, which is also the handler name.
		 * @param {Set<string>} path    The vertices from the root down to this one's parent.
		 * @return {Array<Object>} The rows to hang on this entity.
		 */
		const workersForBranch = ( handler, path ) => {
			const workersForHandler = workersByHandler.get( handler ) || [];
			const upstreamLog = [ ...path ]
				.reverse()
				.find( ( vertex ) => isLog.get( vertex ) );
			if ( upstreamLog === undefined ) {
				return workersForHandler;
			}
			return workersForHandler.filter(
				( worker ) =>
					! worker.source ||
					worker.source ===
						concreteLogForPartition( upstreamLog, worker.partition )
			);
		};

		const catalogNames = [ ...logSlotsByName.keys() ];
		/**
		 * One vertex's out-neighbours.
		 *
		 * @param {string} vertex The vertex to expand.
		 * @return {string[]} Its children, case-insensitively sorted.
		 */
		const childrenOf = ( vertex ) =>
			[ ...( outAdj.get( vertex ) || [] ) ].sort( byLower );
		/**
		 * Build one vertex's entity, as a log or as a node.
		 *
		 * @param {string}      vertex The vertex to draw.
		 * @param {Set<string>} path   The vertices from the root down to its parent.
		 * @param {string}      prefix The parent entity's key.
		 * @return {Object} The entity.
		 */
		const makeVertex = ( vertex, path, prefix ) =>
			isLog.get( vertex )
				? makeLog( vertex, path, prefix )
				: makeNode( vertex, path, prefix );
		/**
		 * Build one entity's children, ending the branch on a cycle.
		 *
		 * A vertex already on the path is its own ancestor, so descending into it
		 * again would never return. The branch stops there and the rest of the
		 * topology still draws.
		 *
		 * @param {string}      vertex    The entity's own vertex.
		 * @param {Set<string>} path      The vertices from the root down to its parent.
		 * @param {string}      parentKey The entity's key, which prefixes each child's.
		 * @return {Array<Object>} The child entities, or none on a cycle.
		 */
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

		/**
		 * The out-neighbour signature convergent siblings share.
		 *
		 * @param {string} vertex The vertex to sign.
		 * @return {string} Its sorted out-neighbours, JSON-encoded.
		 */
		const signatureOf = ( vertex ) =>
			JSON.stringify( [ ...( outAdj.get( vertex ) || [] ) ].sort() );

		/**
		 * May these same-signature siblings draw as one entity?
		 *
		 * Only logic vertices join, and only when they share a downstream. Two
		 * logs with one downstream are still two logs, each with its own segments
		 * and cursor, and leaves that feed nothing have no shared subtree to save.
		 *
		 * @param {string[]} members Siblings sharing an out-neighbour signature.
		 * @return {boolean} True when they render as one entity.
		 */
		const joinable = ( members ) => {
			if ( members.length < 2 ) {
				return false;
			}
			const shared = childrenOf( members[ 0 ] );
			return (
				shared.length > 0 && members.every( ( v ) => ! isLog.get( v ) )
			);
		};

		/**
		 * Build one sibling list, joining each convergent logic group.
		 *
		 * Grouping by kind and signature is what keeps the subtree below a
		 * convergence from being built once per sibling that feeds it.
		 *
		 * @param {string[]}    siblings The vertices at this level.
		 * @param {Set<string>} path     The vertices from the root down to their parent.
		 * @param {string}      prefix   The parent entity's key.
		 * @return {Array<Object>} The entities, alphabetical.
		 */
		const makeSiblings = ( siblings, path, prefix ) => {
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
		/**
		 * One entity's fold key: its parent's key, then its own id.
		 *
		 * The chain starts at the topology name, so every key is scoped to its
		 * topology.
		 *
		 * @param {string} prefix The parent's key, or the topology at a root.
		 * @param {string} id     The vertex name, or the joined members.
		 * @return {string} The key the dashboards fold on.
		 */
		const childKey = ( prefix, id ) => `${ prefix }>${ id }`;
		/**
		 * Order two entities by name, case-insensitively.
		 *
		 * @param {{name:string}} a The first entity.
		 * @param {{name:string}} b The second entity.
		 * @return {number} The comparison `Array.prototype.sort` wants.
		 */
		const byName = ( a, b ) => byLower( a.name, b.name );
		/**
		 * Build a `node` entity: one logic vertex and the rows that staff it.
		 *
		 * @param {string}      vertex The logic vertex.
		 * @param {Set<string>} path   The vertices from the root down to its parent.
		 * @param {string}      prefix The parent entity's key.
		 * @return {Object} The entity.
		 */
		const makeNode = ( vertex, path, prefix ) => {
			const key = childKey( prefix, vertex );
			return {
				kind: 'node',
				name: vertex,
				key,
				workers: workersForBranch( vertex, path ),
				children: makeKids( vertex, path, key ),
			};
		};
		/**
		 * Build one `node` entity out of several convergent logic vertices.
		 *
		 * Their rows pool onto it and the shared subtree is built once, from the
		 * first member: they carry the same out-neighbours, which is what put them
		 * in one group. `names` keeps the members apart for a renderer that wants
		 * them, and the key joins their ids so it stays theirs alone.
		 *
		 * @param {string[]}    members The convergent vertices.
		 * @param {Set<string>} path    The vertices from the root down to their parent.
		 * @param {string}      prefix  The parent entity's key.
		 * @return {Object} The joined entity.
		 */
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
				workers: ids.flatMap( ( id ) => workersForBranch( id, path ) ),
				children: makeSiblings( childrenOf( ids[ 0 ] ), nextPath, key ),
			};
		};
		/**
		 * Build a `log` entity: one logical log, its concrete partitions as rows.
		 *
		 * A tokenized vertex resolves to every catalog entry it matches, and each
		 * becomes a row named by that CONCRETE entry — the key the rate maps use,
		 * so a row finds its rate without rebuilding one. The row's partition
		 * number comes from that name match, never from the slot: a slot that fell
		 * back to a worker row carries the WORKER's partition. `segment_size`
		 * comes from the first partition declaring one, since the partitions of a
		 * log share it.
		 *
		 * @param {string}      vertex The log vertex, tokenized or concrete.
		 * @param {Set<string>} path   The vertices from the root down to its parent.
		 * @param {string}      prefix The parent entity's key.
		 * @return {Object} The entity.
		 */
		const makeLog = ( vertex, path, prefix ) => {
			const concretes = concreteLogNames( vertex, catalogNames );
			const name = logicalLogName( vertex );
			let hasCursor = false;
			const partitions = concretes.map(
				( { name: concrete, partition } ) => {
					const collected = collectLogPartitions( concrete, ctx );
					hasCursor = hasCursor || collected.hasCursor;
					const slot = collected.partitions[ 0 ] || {};
					// The concrete name is the rate key `recordLog` writes.
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
		// @longform Rooted at the TOPOLOGY, not at ''. Overview draws every
		// row against ONE shared fold set, and seven topologies include
		// `topic-probe.tsl`, so a key naming only the tree path makes
		// `topicprobe` one entity across all of them: folding it in one row
		// folds it in every row.
		const roots = makeSiblings( rootVertices, new Set(), topology );
		sections.push( { topology, workers: tWorkers, tree: roots } );
	}
	sections.sort( ( a, b ) => byLower( a.topology, b.topology ) );
	return sections;
}
