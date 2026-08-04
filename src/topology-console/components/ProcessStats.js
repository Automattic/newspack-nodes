/**
 * Shared stats presentation: the Activity sparklines + Throughput totals used by
 * every scope that has counters — the process header (browser, worker) and a
 * selected hull. Lives outside Inspector so HullPanel, which Inspector imports,
 * can render the same view without an import cycle.
 */

import { __, sprintf } from '@wordpress/i18n';
import { computePollIntervalMs } from '../../runtime/metadata-node';
import { FieldRow, Section } from './InspectorFields';

// Inspector sparkline (wider/taller variant of the node-card one).
const INSP_SPARK_HISTORY_MAX = 60;

/**
 * Message-rate label whose precision shrinks as the rate grows: whole numbers
 * from 100/s up, one decimal above 1/s, two below it — so a trickle stays
 * legible without handing a busy node six digits.
 *
 * @param {number|null|undefined} rate Messages per second; nullish reads "—".
 * @return {string} The rate, suffixed "/s".
 */
export function formatRate( rate ) {
	if ( rate === undefined || rate === null ) {
		return '— /s';
	}
	if ( rate === 0 ) {
		return '0 /s';
	}
	if ( rate >= 100 ) {
		return `${ Math.round( rate ) } /s`;
	}
	if ( rate >= 1 ) {
		return `${ rate.toFixed( 1 ) } /s`;
	}
	return `${ rate.toFixed( 2 ) } /s`;
}

/**
 * Byte-rate label with the B/K/M/G suffix its magnitude calls for. Anything
 * under 1 B/s floors to "0 B/s" — a sub-byte rate is noise, not information.
 *
 * @param {number|null|undefined} rate Bytes per second; nullish reads "—".
 * @return {string} The rate, suffixed "/s".
 */
export function formatByteRate( rate ) {
	if ( rate === undefined || rate === null ) {
		return '— /s';
	}
	if ( rate < 1 ) {
		return '0 B/s';
	}
	if ( rate < 1024 ) {
		return `${ Math.round( rate ) } B/s`;
	}
	if ( rate < 1024 * 1024 ) {
		return `${ ( rate / 1024 ).toFixed( 1 ) } K/s`;
	}
	if ( rate < 1024 * 1024 * 1024 ) {
		return `${ ( rate / ( 1024 * 1024 ) ).toFixed( 1 ) } M/s`;
	}
	return `${ ( rate / ( 1024 * 1024 * 1024 ) ).toFixed( 1 ) } G/s`;
}

/**
 * Cumulative byte count with a K/M/G suffix, for glanceable totals. A
 * non-number or a negative reads "—" rather than inventing a value.
 *
 * @param {number|null|undefined} n Byte count.
 * @return {string} The formatted size.
 */
export function formatBytes( n ) {
	if ( typeof n !== 'number' || n < 0 ) {
		return '—';
	}
	if ( n < 1024 ) {
		return `${ n } B`;
	}
	if ( n < 1024 * 1024 ) {
		return `${ ( n / 1024 ).toFixed( 1 ) } K`;
	}
	if ( n < 1024 * 1024 * 1024 ) {
		return `${ ( n / ( 1024 * 1024 ) ).toFixed( 1 ) } M`;
	}
	return `${ ( n / ( 1024 * 1024 * 1024 ) ).toFixed( 1 ) } G`;
}

/**
 * Label for the window the sparklines actually cover: ring capacity × the
 * metadata poll interval, which itself scales with graph size. A fixed "last
 * minute" would lie on a big graph, where one poll is already several seconds.
 *
 * @param {number} nodeCount Nodes in the whole graph; sets the poll interval.
 * @return {string} A "last ~Ns" or "last ~Nm" label.
 */
export function formatActivityWindow( nodeCount ) {
	const windowSec =
		( INSP_SPARK_HISTORY_MAX * computePollIntervalMs( nodeCount ) ) / 1000;
	if ( windowSec < 120 ) {
		return sprintf(
			// translators: %d: trailing activity window length in seconds.
			__( 'last ~%ds', 'newspack-nodes' ),
			Math.round( windowSec )
		);
	}
	return sprintf(
		// translators: %d: trailing activity window length in minutes.
		__( 'last ~%dm', 'newspack-nodes' ),
		Math.round( windowSec / 60 )
	);
}

function inspectorSparklinePath( history, width, height ) {
	if ( ! history || history.length < 2 ) {
		return null;
	}
	const max = Math.max( ...history, 1e-9 );
	const step = width / ( INSP_SPARK_HISTORY_MAX - 1 );
	const startIdx = INSP_SPARK_HISTORY_MAX - history.length;
	return history
		.map( ( v, i ) => {
			const safeV = v > 0 ? v : 0;
			const x = ( startIdx + i ) * step;
			const y = height - ( safeV / max ) * height;
			return `${ i === 0 ? 'M' : 'L' } ${ x.toFixed( 2 ) },${ y.toFixed(
				2
			) }`;
		} )
		.join( ' ' );
}

/**
 * One labeled sparkline row: the curve, its latest value, and its peak. The
 * curve auto-scales to its own maximum, so the peak label is what keeps rows
 * comparable — without it a trickle and a flood draw the same shape.
 *
 * @param {Object}                 props
 * @param {string}                 props.label        Row label, e.g. "messages in /s".
 * @param {number[]}               [props.history]    Trailing samples, oldest first; fewer than two draws no curve.
 * @param {number}                 props.currentValue Latest sample; above zero it takes the accent style.
 * @param {(value:number)=>string} props.format       Formats both the current value and the peak.
 * @return {import('react').ReactElement} The sparkline row.
 */
export function SparklineRow( { label, history, currentValue, format } ) {
	const W = 270;
	const H = 32;
	const path = inspectorSparklinePath( history, W, H );
	const peak = history && history.length ? Math.max( ...history, 0 ) : 0;
	return (
		<div className="topology-insp__spark-row">
			<div className="topology-insp__spark-head">
				<span className="topology-insp__spark-label">{ label }</span>
				<span className="topology-insp__spark-vals">
					<span
						className={ `newspack-nodes-stat-value topology-insp__spark-val${
							currentValue > 0
								? ' is-accent'
								: ' topology-insp__spark-val--dim'
						}` }
					>
						{ format( currentValue ) }
					</span>
					<span className="topology-insp__spark-peak">
						{ __( 'peak', 'newspack-nodes' ) } { format( peak ) }
					</span>
				</span>
			</div>
			<svg
				className="topology-insp__spark-svg"
				viewBox={ `0 0 ${ W } ${ H }` }
				preserveAspectRatio="none"
				aria-hidden="true"
			>
				{ path && (
					<path
						d={ path }
						className="topology-insp__spark-path"
						fill="none"
					/>
				) }
			</svg>
		</div>
	);
}

const lastSample = ( arr ) => ( arr.length ? arr[ arr.length - 1 ] : 0 );

/**
 * Builds the four Activity rows in one place, so their labels and formatters
 * cannot drift between the stat sources that render them.
 *
 * @param {number[]} msgIn     Messages-in per-second samples.
 * @param {number[]} msgOut    Messages-out per-second samples.
 * @param {number[]} byteRead  Bytes-read per-second samples.
 * @param {number[]} byteWrite Bytes-written per-second samples.
 * @return {Array} Rows shaped for SparklineRow's props.
 */
export function buildActivity( msgIn, msgOut, byteRead, byteWrite ) {
	const row = ( label, series, format ) => ( {
		label,
		history: series,
		currentValue: lastSample( series ),
		format,
	} );
	return [
		row( __( 'messages in /s', 'newspack-nodes' ), msgIn, formatRate ),
		row( __( 'messages out /s', 'newspack-nodes' ), msgOut, formatRate ),
		row(
			__( 'bytes read /s', 'newspack-nodes' ),
			byteRead,
			formatByteRate
		),
		row(
			__( 'bytes written /s', 'newspack-nodes' ),
			byteWrite,
			formatByteRate
		),
	];
}

/**
 * Presentational stats body: Activity + Throughput, plus the dmesg strip when
 * `levels` is given. A hull passes none — err/warn counts are process-wide, so
 * showing them under one include's name would attribute the whole process to it.
 *
 * @param {Object}      props
 * @param {string}      props.windowMeta Trailing-window label for Activity.
 * @param {Array}       props.activity   Rows from buildActivity().
 * @param {Object}      props.totals     Cumulative msgsIn/msgsOut/bytes{Read,Written}.
 * @param {Object|null} [props.levels]   Process dmesg counts; omitted or null
 *                                       renders no dmesg strip.
 * @param {string}      [props.testId]   data-testid for the wrapper; defaults to
 *                                       `inspector-process-stats`.
 * @return {import('react').ReactElement} The stats body.
 */
export function ProcessStatsView( {
	windowMeta,
	activity,
	totals,
	levels = null,
	testId = 'inspector-process-stats',
} ) {
	return (
		<div className="topology-insp__stats" data-testid={ testId }>
			<Section
				title={ __( 'Activity', 'newspack-nodes' ) }
				meta={ windowMeta }
			>
				{ activity.map( ( a ) => (
					<SparklineRow
						key={ a.label }
						label={ a.label }
						history={ a.history }
						currentValue={ a.currentValue }
						format={ a.format }
					/>
				) ) }
			</Section>
			<Section
				title={ __( 'Throughput', 'newspack-nodes' ) }
				meta={ __( 'cumulative', 'newspack-nodes' ) }
			>
				<FieldRow
					k="msgs in"
					v={ totals.msgsIn.toLocaleString() }
					vClass="newspack-nodes-stat-value is-accent topology-field-row__val--num"
				/>
				<FieldRow
					k="msgs out"
					v={ totals.msgsOut.toLocaleString() }
					vClass="newspack-nodes-stat-value is-accent topology-field-row__val--num"
				/>
				<FieldRow
					k="bytes read"
					v={ formatBytes( totals.bytesRead ) }
					vClass="newspack-nodes-stat-value is-accent topology-field-row__val--num"
				/>
				<FieldRow
					k="bytes written"
					v={ formatBytes( totals.bytesWritten ) }
					vClass="newspack-nodes-stat-value is-accent topology-field-row__val--num"
				/>
			</Section>
			{ levels && (
				<div className="topology-insp__levels">
					<span className="newspack-nodes-status is-error topology-insp__level topology-insp__level--error">
						{ sprintf(
							// translators: %d: error line count.
							__( '%d err', 'newspack-nodes' ),
							levels.errors
						) }
					</span>
					<span className="newspack-nodes-status is-accent topology-insp__level topology-insp__level--warn">
						{ sprintf(
							// translators: %d: warning line count.
							__( '%d warn', 'newspack-nodes' ),
							levels.warnings
						) }
					</span>
					<span className="newspack-nodes-status topology-insp__level topology-insp__level--debug">
						{ sprintf(
							// translators: %d: debug line count.
							__( '%d dbg', 'newspack-nodes' ),
							levels.debug
						) }
					</span>
				</div>
			) }
		</div>
	);
}

/**
 * Rate series → the four Activity rows, for callers holding a
 * useAggregateRateSeries result.
 *
 * @param {Object} series `{ in, out, read, write }` sample rings.
 * @return {Array} Activity rows.
 */
export function activityFromSeries( series ) {
	const {
		in: inSpark = [],
		out: outSpark = [],
		read: readSpark = [],
		write: writeSpark = [],
	} = series || {};
	return buildActivity( inSpark, outSpark, readSpark, writeSpark );
}
