/**
 * TablestatsViewNode — the per-Table operation stream behind the Tables tab.
 * See ProbeStreamViewNode for the buckets, the retention window and the
 * eviction it shares.
 */

import * as Tbl from '../../runtime/tablestats-record';
import { ProbeStreamViewNode, bucketTotals } from './probe-stream-view-node';

/**
 * Sample field prefix one operation's calls ride under, so each tallies as a
 * delta a chart divides into a rate.
 */
export const OP_PREFIX = 'op:';

/** The operations whose keys asked and answered are reads. */
const READS = [ 'GET', 'MGET' ];

/** The scalars `_windowed` sums over the window, and the longest call. */
const TOTALED = [
	'maxMs',
	'opsDelta',
	'readKeys',
	'hitKeys',
	'errorsDelta',
	'purgedDelta',
	'walWritten',
	'walFrames',
	'ms',
];

/**
 * A level slot as the record carries it: null where the Table has no such
 * thing, else a number.
 *
 * @param {*} raw The slot.
 * @return {?number} The level, or null.
 */
const level = ( raw ) => ( null === raw ? null : Number( raw ) || 0 );

/**
 * `tablestats:view` — owns the Table_Probe stream view model.
 *
 * Each inbound frame is one Table's positional `Tablestats_Record`. Per Table
 * the view folds one sample of scalars into its bucket: the record's totals
 * over every operation, its keys missed, each operation's calls as an
 * `op:<OP>` field, the longest call, and the file size and the disk it takes.
 * The charts divide these into calls and misses per second and a mean ms.
 * Every value is read off THAT record and nothing is differenced
 * across records. A level the record carries as null, a figure its backend
 * has no such thing for, stays null and tallies nothing. The window rollup
 * the table renders is summed over the retained buckets in `_entryView`, so
 * it shrinks as buckets age out.
 */
export class TablestatsViewNode extends ProbeStreamViewNode {
	/** Record slot the base keys entries by: the Table's file stem. */
	identitySlot = Tbl.IDENTITY;

	/** Wrapper key the published model uses, so React reads `view.tables`. */
	modelKey = 'tables';

	/** What `nodeSchema()` reports to the console palette and to `help`. */
	static description =
		'Table_Probe stream render-model sink (the React view node).';

	/**
	 * The published per-Table snapshot: its identity and backend, the window
	 * rollup the table reads, the newest levels with the instant they were
	 * swept, and the buckets.
	 *
	 * @param {Object} c The internal entry.
	 * @return {Object} { key, backend, windowed, latest, buckets }.
	 */
	_entryView( c ) {
		const buckets = this._buckets( c );
		return {
			key: c.key,
			backend: c.backend,
			windowed: this._windowed( buckets ),
			latest: {
				ts: c.ts,
				fileBytes: c.fileBytes,
				fileDiskBytes: c.fileDiskBytes,
				purgeBehind: c.purgeBehind,
				walStalled: c.walStalled,
			},
			buckets,
		};
	}

	/**
	 * Sum the scalars over the retained buckets. Hit % is null when the
	 * window read no keys, and the mean and max ms are null when it made no
	 * call, so a cell can say so rather than claim 0.
	 *
	 * @param {Array<import('./probe-stream-view-node').Bucket>} buckets The Table's buckets.
	 * @return {Object} The rollup.
	 */
	_windowed( buckets ) {
		const t = bucketTotals( buckets, TOTALED );
		const sum = ( f ) => t[ f ].sum;
		const ops = sum( 'opsDelta' );
		return {
			ops,
			readKeys: sum( 'readKeys' ),
			hitKeys: sum( 'hitKeys' ),
			hitPct:
				sum( 'readKeys' ) > 0
					? ( 100 * sum( 'hitKeys' ) ) / sum( 'readKeys' )
					: null,
			meanMs: ops > 0 ? sum( 'ms' ) / ops : null,
			maxMs: ops > 0 ? t.maxMs.max : null,
			errors: sum( 'errorsDelta' ),
			purged: sum( 'purgedDelta' ),
			walWritten: sum( 'walWritten' ),
			walFrames: sum( 'walFrames' ),
		};
	}

	/**
	 * Fold one record into its Table's entry and yield its sample.
	 *
	 * @param {Object}               c      The Table's entry, keyed by `IDENTITY`.
	 * @param {Array<string|number>} value  The positional `Tablestats_Record` VALUE.
	 * @param {number}               ts     Snapshot instant (epoch seconds).
	 * @param {string}               worker The worker that swept it, or `''`.
	 * @return {Object} The sample its bucket tallies.
	 */
	_fold( c, value, ts, worker ) {
		c.ts = ts;
		c.backend = String( value[ Tbl.BACKEND ] ?? c.backend ?? '' );
		c.purgeBehind = level( value[ Tbl.PURGE_BEHIND ] );
		c.walStalled = level( value[ Tbl.WAL_STALLED ] );
		c.fileBytes = level( value[ Tbl.FILE_BYTES ] );
		c.fileDiskBytes = level( value[ Tbl.FILE_DISK_BYTES ] );

		const s = {
			ts,
			worker,
			elapsed: this._delta( value[ Tbl.ELAPSED_MS ] ) / 1000,
			opsDelta: 0,
			readKeys: 0,
			hitKeys: 0,
			errorsDelta: 0,
			purgedDelta: 0,
			walWritten: 0,
			walFrames: 0,
			ms: 0,
			maxMs: 0,
			fileBytes: c.fileBytes,
			fileDiskBytes: c.fileDiskBytes,
		};
		const raw = value[ Tbl.VERBS ];
		for ( const [ op, r ] of Object.entries(
			raw && 'object' === typeof raw ? raw : {}
		) ) {
			if ( ! Array.isArray( r ) ) {
				continue;
			}
			const calls = this._delta( r[ Tbl.ROW_CALLS ] );
			const asked = this._delta( r[ Tbl.ROW_ASKED ] );
			const answered = this._delta( r[ Tbl.ROW_ANSWERED ] );
			s.opsDelta += calls;
			s.errorsDelta += this._delta( r[ Tbl.ROW_ERRORS ] );
			s.ms += this._delta( r[ Tbl.ROW_MS ] );
			s.maxMs = Math.max( s.maxMs, this._delta( r[ Tbl.ROW_MAX_MS ] ) );
			s[ OP_PREFIX + op ] = calls;
			if ( READS.includes( op ) ) {
				s.readKeys += asked;
				s.hitKeys += answered;
			} else if ( 'PURGE' === op ) {
				s.purgedDelta = answered;
			} else if ( 'CHECKPOINT' === op ) {
				s.walWritten = answered;
				s.walFrames = asked;
			}
		}
		s.misses = Math.max( 0, s.readKeys - s.hitKeys );
		return s;
	}
}
