/**
 * The dashboards' presentation formatters: byte sizes, byte/message rates,
 * compact counts, worker age, consumer ETA. One home for all of them — the
 * event dashboards, the debug overlay and the topology console render every
 * number through this module, so no two surfaces can disagree about what
 * 881869 bytes reads as.
 */

import { __ } from '@wordpress/i18n';

/**
 * A rate ladder is derived from its base ladder, so the two cannot drift.
 *
 * @param {string[]} units Rung labels.
 * @return {string[]} The same rungs, per second.
 */
const perSecond = ( units ) => units.map( ( unit ) => `${ unit }/s` );
const BYTE_UNITS = [ ' B', ' KB', ' MB', ' GB', ' TB' ];
const COUNT_UNITS = [ '', 'K', 'M', 'B' ];
const BYTE_RATE_UNITS = perSecond( BYTE_UNITS );
const MSG_RATE_UNITS = perSecond( COUNT_UNITS );

/**
 * Compact decimals for a unit-scaled value: one decimal place under 10, none
 * at or above it. `parseFloat` then drops a trailing ".0", so 2 KB reads "2 KB"
 * rather than "2.0 KB".
 *
 * @param {number} value Unit-scaled value (e.g. bytes / 1024^i).
 * @return {number} The value rounded to the compact precision.
 */
function compactFixed( value ) {
	return parseFloat( value.toFixed( value >= 10 ? 0 : 1 ) );
}

/**
 * The one unit scaler: pick the ladder rung a value belongs on, divide, round
 * compactly, append the rung's label.
 *
 * Anything that is not a positive finite number reads as the ladder's zero form
 * ("0 B", "0/s", "0") — a dashboard cell is no place to surface a NaN, and the
 * callers' inputs are aggregates that can arrive absent or clock-skewed.
 *
 * @param {number}   value Raw value.
 * @param {number}   base  Ladder base: 1024 for bytes, 1000 for counts.
 * @param {string[]} units Rung labels, smallest first, each carrying its own
 *                         separator and suffix.
 * @return {string} The formatted value.
 */
function scaleUnits( value, base, units ) {
	if ( ! Number.isFinite( value ) || value <= 0 ) {
		return `0${ units[ 0 ] }`;
	}
	const top = units.length - 1;
	let i = Math.min(
		top,
		Math.max( 0, Math.floor( Math.log( value ) / Math.log( base ) ) )
	);
	let scaled = compactFixed( value / base ** i );
	// Rounding can reach the base (999999 → "1000K"); promote a rung instead.
	if ( scaled >= base && i < top ) {
		i++;
		scaled = compactFixed( value / base ** i );
	}
	return `${ scaled }${ units[ i ] }`;
}

/**
 * Format a byte count, e.g. 1536 → "1.5 KB".
 *
 * @param {number} bytes Byte count.
 * @return {string} Formatted size.
 */
export function formatBytes( bytes ) {
	return scaleUnits( bytes, 1024, BYTE_UNITS );
}

/**
 * Format bytes per second, e.g. 47514 → "46 KB/s".
 *
 * @param {number} bytesPerSec Bytes per second.
 * @return {string} Formatted rate.
 */
export function formatByteRate( bytesPerSec ) {
	return scaleUnits( bytesPerSec, 1024, BYTE_RATE_UNITS );
}

/**
 * Format a message rate, e.g. 2996 → "3K/s".
 *
 * @param {number} perSec Messages per second.
 * @return {string} Formatted rate.
 */
export function formatMsgRate( perSec ) {
	return scaleUnits( perSec, 1000, MSG_RATE_UNITS );
}

/**
 * Format a count, e.g. 1500 → "1.5K".
 *
 * @param {number} n A count.
 * @return {string} Compacted count.
 */
export function formatCount( n ) {
	return scaleUnits( n, 1000, COUNT_UNITS );
}

/**
 * Format age as human readable duration.
 *
 * @param {number} startedAt Unix timestamp when worker started.
 * @param {number} now       Current Unix timestamp.
 * @return {string} Formatted duration string.
 */
export function formatAge( startedAt, now ) {
	if ( ! startedAt ) {
		return '-';
	}
	const seconds = now - startedAt;
	if ( seconds < 60 ) {
		return `${ seconds }s`;
	}
	if ( seconds < 3600 ) {
		const mins = Math.floor( seconds / 60 );
		return `${ mins }m`;
	}
	const hours = Math.floor( seconds / 3600 );
	const mins = Math.floor( ( seconds % 3600 ) / 60 );
	return `${ hours }h${ mins }m`;
}

/**
 * Seconds to drain `bytesBehind` at `readRate`. 0 when not behind; Infinity when
 * there's lag but no read progress (stalled). The numeric core behind formatEta
 * and the health rollup's "behind" threshold.
 *
 * @param {number} bytesBehind Bytes remaining to process.
 * @param {number} readRate    Current read rate in bytes per second.
 * @return {number} Seconds (0 / Infinity / ceil(behind/rate)).
 */
export function etaSeconds( bytesBehind, readRate ) {
	if ( ! bytesBehind || bytesBehind <= 0 ) {
		return 0;
	}
	if ( ! readRate || readRate <= 0 ) {
		return Infinity;
	}
	return Math.ceil( bytesBehind / readRate );
}

/**
 * Format an ETA already expressed in seconds (the output of `etaSeconds`).
 * 0 → '' (caught up); Infinity → 'stalled'; else a human duration.
 *
 * @param {number} seconds ETA seconds (0 / Infinity / finite).
 * @return {string} Formatted ETA string or empty.
 */
export function formatEtaSeconds( seconds ) {
	if ( ! seconds || seconds <= 0 ) {
		return '';
	}
	if ( ! Number.isFinite( seconds ) ) {
		return __( 'stalled', 'newspack-nodes' );
	}
	if ( seconds < 60 ) {
		return `${ seconds }s`;
	}
	if ( seconds < 3600 ) {
		const mins = Math.ceil( seconds / 60 );
		return `${ mins }m`;
	}
	const hours = Math.floor( seconds / 3600 );
	const mins = Math.ceil( ( seconds % 3600 ) / 60 );
	return `${ hours }h${ mins }m`;
}

/**
 * Format ETA as human readable duration.
 *
 * @param {number} bytesBehind Bytes remaining to process.
 * @param {number} readRate    Current read rate in bytes per second.
 * @return {string} Formatted ETA string or empty if not applicable.
 */
export function formatEta( bytesBehind, readRate ) {
	return formatEtaSeconds( etaSeconds( bytesBehind, readRate ) );
}
