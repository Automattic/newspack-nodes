/**
 * TablestatsViewNode — the per-Table operation stream behind the Tables tab.
 * See ProbeStreamViewNode for the ring, the retention window and the eviction
 * it shares.
 */

import * as Tbl from '../../runtime/tablestats-record';
import { ProbeStreamViewNode } from './probe-stream-view-node';

/** The operations whose keys asked and answered are reads. */
const READS = [ 'GET', 'MGET' ];

/** A sample's scalars `_windowed` sums over the window. */
const SUMMED = [
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
 * the view pushes one sample of scalars: the record's totals over every
 * operation, each operation's calls per second, and the figures the charts
 * plot — calls per second, keys missed per second, mean and longest ms, and
 * the file size. Every value is read off THAT record and nothing is
 * differenced across records. A level the record carries as null, a figure
 * its backend has no such thing for, stays null. The window rollup the table
 * renders is summed over the retained samples in `_entryView`, so it shrinks
 * as samples age out.
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
	 * swept, and a copy of the series.
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
				ts: c.ts,
				fileBytes: c.fileBytes,
				purgeBehind: c.purgeBehind,
				walStalled: c.walStalled,
			},
			series: c.series.slice(),
		};
	}

	/**
	 * Sum the retained samples' scalars. Hit % is null when the window read
	 * no keys, and the mean and max ms are null when it made no call, so a
	 * cell can say so rather than claim 0.
	 *
	 * @param {Array<Object>} series The per-Table ring of samples.
	 * @return {Object} The rollup.
	 */
	_windowed( series ) {
		const t = Object.fromEntries( SUMMED.map( ( f ) => [ f, 0 ] ) );
		let maxMs = 0;
		for ( const s of series ) {
			for ( const f of SUMMED ) {
				t[ f ] += s[ f ];
			}
			maxMs = Math.max( maxMs, s.maxMs );
		}
		const ops = t.opsDelta;
		return {
			ops,
			readKeys: t.readKeys,
			hitKeys: t.hitKeys,
			hitPct: t.readKeys > 0 ? ( 100 * t.hitKeys ) / t.readKeys : null,
			meanMs: ops > 0 ? t.ms / ops : null,
			maxMs: ops > 0 ? maxMs : null,
			errors: t.errorsDelta,
			purged: t.purgedDelta,
			walWritten: t.walWritten,
			walFrames: t.walFrames,
		};
	}

	/**
	 * Fold one record into its Table's entry and yield its sample.
	 *
	 * @param {Object}               c      The Table's entry, keyed by `IDENTITY`.
	 * @param {Array<string|number>} value  The positional `Tablestats_Record` VALUE.
	 * @param {number}               ts     Snapshot instant (epoch seconds).
	 * @param {string}               worker The worker that swept it, or `''`.
	 * @return {Object} The sample to push onto the entry's series.
	 */
	_fold( c, value, ts, worker ) {
		c.ts = ts;
		c.backend = String( value[ Tbl.BACKEND ] ?? c.backend ?? '' );
		c.purgeBehind = level( value[ Tbl.PURGE_BEHIND ] );
		c.walStalled = level( value[ Tbl.WAL_STALLED ] );
		c.fileBytes = level( value[ Tbl.FILE_BYTES ] );

		const elapsed = this._delta( value[ Tbl.ELAPSED_MS ] ) / 1000;
		const per = ( n ) => ( elapsed > 0 ? n / elapsed : 0 );
		const s = {
			ts,
			worker,
			elapsed,
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
			opRates: {},
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
			s.opRates[ op ] = per( calls );
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
		s.opsRate = per( s.opsDelta );
		s.missRate = per( Math.max( 0, s.readKeys - s.hitKeys ) );
		s.errorsRate = per( s.errorsDelta );
		s.meanMs = s.opsDelta > 0 ? s.ms / s.opsDelta : 0;
		return s;
	}
}
