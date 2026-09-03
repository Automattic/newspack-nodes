/**
 * The dashboards' presentation formatters: byte sizes, byte/message rates,
 * compact counts, elapsed age, consumer ETA. One home for all of them — the
 * event dashboards, the debug overlay and the topology console render every
 * number through this module, so no two surfaces can disagree about what
 * 881869 bytes reads as.
 */

import { __ } from '@wordpress/i18n';

import { binaryTicks } from './axis-ticks';

/**
 * A rate ladder is derived from its base ladder, so the two cannot drift.
 *
 * @param {string[]} units Rung labels.
 * @return {string[]} The same rungs, per second.
 */
const perSecond = ( units ) => units.map( ( unit ) => `${ unit }/s` );

/**
 * The byte ladder, each rung carrying the space "1.5 KB" reads with. The
 * separator lives in the label so `scaleUnits` concatenates a rung without
 * knowing which ladder handed it over.
 */
const BYTE_UNITS = [ ' B', ' KB', ' MB', ' GB', ' TB' ];

/**
 * The count ladder, spaceless, because a count reads "1.5K". Its top rung is
 * billions — the one `B` in this module that does not mean bytes.
 */
const COUNT_UNITS = [ '', 'K', 'M', 'B' ];

/** The byte ladder per second, e.g. "46 KB/s". */
const BYTE_RATE_UNITS = perSecond( BYTE_UNITS );

/** The count ladder per second, e.g. "3K/s". */
const MSG_RATE_UNITS = perSecond( COUNT_UNITS );

/**
 * Compact decimals for a unit-scaled value: one decimal place under 10, none
 * at or above it. `parseFloat` then drops a trailing ".0", so 2 KB reads "2 KB"
 * rather than "2.0 KB".
 *
 * The one precision rule every unit ladder here rounds by. It ships on the
 * `@newspack-nodes/shared` surface so a ladder in a consumer plugin's own
 * chart rounds identically.
 *
 * @param {number} value Unit-scaled value (e.g. bytes / 1024^i).
 * @return {number} The value rounded to the compact precision.
 */
export function compactFixed( value ) {
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
 * The rung index clamps at both ends. A value under the first rung stays on it
 * ("0.5 B") and one past the last keeps counting in it ("1024 TB"), rather than
 * indexing off the ladder into an `undefined` label.
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
 * `tickValues` hands `drawAxes` the power-of-two ladder to tick a byte axis
 * with, because d3's own base-10 tick values divide by 1024 into fractions: an
 * axis ticked at 1,000,000 reads "977 KB". The base-1000 formatters carry no
 * such property, d3's ticks being round in their base already.
 *
 * @param {number} bytes Byte count.
 * @return {string} Formatted size.
 */
export function formatBytes( bytes ) {
	return scaleUnits( bytes, 1024, BYTE_UNITS );
}
formatBytes.tickValues = binaryTicks;

/**
 * Format bytes per second, e.g. 47514 → "46 KB/s". Ticks an axis on the same
 * power-of-two ladder as `formatBytes`.
 *
 * @param {number} bytesPerSec Bytes per second.
 * @return {string} Formatted rate.
 */
export function formatByteRate( bytesPerSec ) {
	return scaleUnits( bytesPerSec, 1024, BYTE_RATE_UNITS );
}
formatByteRate.tickValues = binaryTicks;

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
 * Format the interval between two Unix timestamps, e.g. 3660 seconds → "1h1m".
 * Whole units: seconds below a minute, minutes below an hour, hours and
 * minutes above.
 *
 * A falsy start reads "-" instead of an age measured from the epoch, since a
 * worker's start, an SSE connection and a job's last run can each be absent.
 * `now` is a parameter so every row of a table ages against one clock reading.
 *
 * @param {number} startedAt Unix timestamp the interval starts at.
 * @param {number} now       Unix timestamp to measure it against.
 * @return {string} Formatted duration, or "-" when `startedAt` is absent.
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
 * Minutes round UP here and down in `formatAge`: an estimate rounded down
 * promises a catch-up the read rate does not support, while an elapsed age
 * rounded up claims time that has not passed.
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
 * Format the ETA for `bytesBehind` at `readRate`, e.g. 1200 bytes at 10 B/s →
 * "2m". Composes `etaSeconds` with `formatEtaSeconds` for a caller that wants
 * only the string.
 *
 * @param {number} bytesBehind Bytes remaining to process.
 * @param {number} readRate    Current read rate in bytes per second.
 * @return {string} Formatted ETA, or empty when not behind.
 */
export function formatEta( bytesBehind, readRate ) {
	return formatEtaSeconds( etaSeconds( bytesBehind, readRate ) );
}
