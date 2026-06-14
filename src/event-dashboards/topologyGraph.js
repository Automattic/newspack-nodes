/**
 * Pure builder: flat `dump_metadata` worker list → one node/log tree per topology.
 *
 * Each topology (worker `type`) becomes a section whose `tree` roots at source
 * nodes (no inputs) and logs consumed-but-not-produced. A node's children are
 * its output logs; a log's children are its reader nodes — collapsing the
 * Partition (writer) and Consumer (reader) into one log node automatically,
 * since both are already represented as log *names* in `outputs`/`inputs`.
 */

const lc = ( s ) => String( s ).toLowerCase();
const byLower = ( a, b ) => {
	const x = lc( a );
	const y = lc( b );
	if ( x < y ) {
		return -1;
	}
	return x > y ? 1 : 0;
};
const byName = ( a, b ) => byLower( a.name, b.name );

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
 * Build one node/log tree section per topology.
 *
 * @param {Array} workers     Worker descriptors from `dump_metadata`.
 * @param {Array} logsCatalog Top-level `logs` array (canonical per-log slots).
 * @return {Array} Sections `[{ topology, tree }]`, alpha-sorted by topology.
 */
export function buildTopologySections( workers, logsCatalog = [] ) {
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
	for ( const [ topology, tWorkers ] of byType ) {
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

		const makeNode = ( step, path ) => ( {
			kind: 'node',
			name: step.handlerName,
			key: step.key,
			workers: step.workers,
			children: [ ...step.outputs ]
				.map( ( n ) => makeLog( n, path ) )
				.sort( byName ),
		} );
		const makeLog = ( logName, path ) => {
			const { partitions, hasCursor } = collectLogPartitions(
				logName,
				ctx
			);
			const segmentSize = logSegmentSizeByName.get( logName );
			if ( path.has( `log:${ logName }` ) ) {
				return {
					kind: 'log',
					name: logName,
					key: `log:${ logName }`,
					partitions,
					hasCursor,
					segment_size: segmentSize,
					children: [],
				};
			}
			const nextPath = new Set( path ).add( `log:${ logName }` );
			const children = ( consumers.get( logName ) || [] )
				.map( ( k ) => stepByKey.get( k ) )
				.filter( Boolean )
				.map( ( s ) => makeNode( s, nextPath ) )
				.sort( byName );
			return {
				kind: 'log',
				name: logName,
				key: `log:${ logName }`,
				partitions,
				hasCursor,
				segment_size: segmentSize,
				children,
			};
		};

		const rootNodes = steps
			.filter( ( s ) => s.inputs.length === 0 )
			.map( ( s ) => makeNode( s, new Set() ) );
		const rootLogs = [ ...consumers.keys() ]
			.filter( ( n ) => ! producers.has( n ) )
			.map( ( n ) => makeLog( n, new Set() ) );
		sections.push( {
			topology,
			workers: tWorkers,
			tree: [ ...rootNodes, ...rootLogs ].sort( byName ),
		} );
	}
	sections.sort( ( a, b ) => byLower( a.topology, b.topology ) );
	return sections;
}
