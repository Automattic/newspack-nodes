/**
 * TablestatsViewNode — the per-Table operation stream behind the Tables tab.
 * See ProbeStreamViewNode for the ring, the retention window and the eviction
 * it shares.
 */

import * as Tbl from '../../runtime/tablestats-record';
import { ProbeStreamViewNode } from './probe-stream-view-node';

/** Fields one operation's row carries, by ROW_ slot. */
const ROW_FIELDS = [
	[ 'calls', Tbl.ROW_CALLS ],
	[ 'asked', Tbl.ROW_ASKED ],
	[ 'answered', Tbl.ROW_ANSWERED ],
	[ 'bytes', Tbl.ROW_BYTES ],
	[ 'ms', Tbl.ROW_MS ],
	[ 'maxMs', Tbl.ROW_MAX_MS ],
	[ 'errors', Tbl.ROW_ERRORS ],
];

/** The operations whose keys asked and answered are reads. */
const READS = [ 'GET', 'MGET' ];

/**
 * `tablestats:view` — owns the Table_Probe stream view model.
 *
 * Each inbound frame is one Table's positional `Tablestats_Record`. Per Table
 * the view pushes one sample carrying that record's per-operation rows and
 * the figures the charts plot: every operation's calls per second and their
 * sum, keys missed per second, mean and longest ms, and the file size. Every
 * value is read off THAT record and nothing is differenced across records.
 * The window rollup the table renders is summed over the retained series in
 * `_entryView`, so it shrinks as samples age out.
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
	 * Fold one record into its Table's entry and yield its sample.
	 *
	 * @param {Object}               c     The Table's entry, keyed by `IDENTITY`.
	 * @param {Array<string|number>} value The positional `Tablestats_Record` VALUE.
	 * @param {number}               ts    Snapshot instant (epoch seconds).
	 * @return {Object} The sample to push onto the entry's series.
	 */
	_fold( c, value, ts ) {
		c.backend = String( value[ Tbl.BACKEND ] ?? c.backend ?? '' );
		c.purgeBehind = Number( value[ Tbl.PURGE_BEHIND ] ) || 0;
		c.walStalled = Number( value[ Tbl.WAL_STALLED ] ) || 0;
		c.fileBytes = Number( value[ Tbl.FILE_BYTES ] ) || 0;

		const raw = value[ Tbl.VERBS ];
		const verbs = {};
		for ( const [ op, r ] of Object.entries(
			raw && 'object' === typeof raw ? raw : {}
		) ) {
			if ( Array.isArray( r ) ) {
				verbs[ op ] = Object.fromEntries(
					ROW_FIELDS.map( ( [ f, i ] ) => [
						f,
						this._delta( r[ i ] ),
					] )
				);
			}
		}
		const t = this._rollup( verbs );
		const elapsed = this._delta( value[ Tbl.ELAPSED_MS ] ) / 1000;
		const per = ( n ) => ( elapsed > 0 ? n / elapsed : 0 );
		return {
			ts,
			elapsed,
			verbs,
			opsDelta: t.ops,
			readKeys: t.readKeys,
			hitKeys: t.hitKeys,
			errorsDelta: t.errors,
			purgedDelta: t.purged,
			walWritten: t.walWritten,
			walFrames: t.walFrames,
			opsRate: per( t.ops ),
			missRate: per( Math.max( 0, t.readKeys - t.hitKeys ) ),
			errorsRate: per( t.errors ),
			opRates: Object.fromEntries(
				Object.entries( verbs ).map( ( [ op, r ] ) => [
					op,
					per( r.calls ),
				] )
			),
			meanMs: t.ops > 0 ? t.ms / t.ops : 0,
			maxMs: t.maxMs,
			fileBytes: c.fileBytes,
		};
	}

	/**
	 * The published per-Table snapshot: its identity and backend, the window
	 * rollup the table reads, the newest levels, and a copy of the series.
	 *
	 * @param {Object} c The internal entry.
	 * @return {Object} { key, backend, windowed, latest, series }.
	 */
	_entryView( c ) {
		return {
			key: c.key,
			backend: c.backend,
			windowed: this._windowed( c.series ),
			latest: {
				fileBytes: c.fileBytes,
				purgeBehind: c.purgeBehind,
				walStalled: c.walStalled,
			},
			series: c.series.slice(),
		};
	}

	/**
	 * Sum the retained series per operation, then roll the sums up. Hit % is
	 * null when the window read no keys, so the cell can say so rather than
	 * claim 0% or 100%.
	 *
	 * @param {Array<Object>} series The per-Table ring of samples.
	 * @return {Object} The rollup.
	 */
	_windowed( series ) {
		const verbs = {};
		for ( const s of series ) {
			for ( const op in s.verbs ) {
				const r = s.verbs[ op ];
				const acc = ( verbs[ op ] ||= Object.fromEntries(
					ROW_FIELDS.map( ( [ f ] ) => [ f, 0 ] )
				) );
				for ( const [ f ] of ROW_FIELDS ) {
					acc[ f ] =
						'maxMs' === f
							? Math.max( acc[ f ], r[ f ] )
							: acc[ f ] + r[ f ];
				}
			}
		}
		const t = this._rollup( verbs );
		return {
			ops: t.ops,
			readKeys: t.readKeys,
			hitKeys: t.hitKeys,
			hitPct: t.readKeys > 0 ? ( 100 * t.hitKeys ) / t.readKeys : null,
			meanMs: t.ops > 0 ? t.ms / t.ops : 0,
			maxMs: t.maxMs,
			errors: t.errors,
			purged: t.purged,
			walWritten: t.walWritten,
			walFrames: t.walFrames,
			verbs,
		};
	}

	/**
	 * Totals of one operations map: every operation's calls and errors, the
	 * keys the reads asked and answered, what upkeep purged and wrote, and the
	 * time spent. Runs on one record's map and on a window's summed map alike.
	 *
	 * @param {Object<string,Object>} verbs Operation name to its row.
	 * @return {Object} { ops, readKeys, hitKeys, errors, purged, walWritten, walFrames, ms, maxMs }.
	 */
	_rollup( verbs ) {
		const t = {
			ops: 0,
			readKeys: 0,
			hitKeys: 0,
			errors: 0,
			purged: verbs.PURGE?.answered ?? 0,
			walWritten: verbs.CHECKPOINT?.answered ?? 0,
			walFrames: verbs.CHECKPOINT?.asked ?? 0,
			ms: 0,
			maxMs: 0,
		};
		for ( const op in verbs ) {
			const r = verbs[ op ];
			t.ops += r.calls;
			t.errors += r.errors;
			t.ms += r.ms;
			t.maxMs = Math.max( t.maxMs, r.maxMs );
			if ( READS.includes( op ) ) {
				t.readKeys += r.asked;
				t.hitKeys += r.answered;
			}
		}
		return t;
	}
}
