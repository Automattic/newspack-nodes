/**
 * Shared presentation formatters for the event dashboards (bytes, rates, age, ETA).
 */

import { __ } from '@wordpress/i18n';

/**
 * Compact decimals for a unit-scaled value: one decimal place under 10, none
 * at/above. Keeps the number to at most 3 characters ("4.1", "46" — never
 * "46.4") so the rate/byte cards don't jitter their width as the value changes.
 *
 * @param {number} value Unit-scaled value (e.g. bytes / 1024^i).
 * @return {number} The value rounded to the compact precision.
 */
function compactFixed( value ) {
	return parseFloat( value.toFixed( value >= 10 ? 0 : 1 ) );
}

/**
 * Format bytes to human readable string.
 *
 * @param {number} bytes Byte count.
 * @return {string} Formatted string.
 */
export function formatBytes( bytes ) {
	if ( ! bytes || bytes === 0 ) {
		return '0 B';
	}
	const k = 1024;
	const sizes = [ 'B', 'KB', 'MB', 'GB' ];
	const i = Math.floor( Math.log( bytes ) / Math.log( k ) );
	return compactFixed( bytes / Math.pow( k, i ) ) + ' ' + sizes[ i ];
}

/**
 * Format bytes per second to human readable string.
 *
 * @param {number} bytesPerSec Bytes per second.
 * @return {string} Formatted string.
 */
export function formatByteRate( bytesPerSec ) {
	if ( ! bytesPerSec || bytesPerSec === 0 ) {
		return '0 B/s';
	}
	const k = 1024;
	const sizes = [ 'B/s', 'KB/s', 'MB/s', 'GB/s' ];
	// Clamp into [0, sizes-1]: a sub-1 B/s rate floors to a negative index and a
	// >GB/s rate overflows — both would index `sizes` to `undefined` → "NaN".
	const i = Math.max(
		0,
		Math.min(
			sizes.length - 1,
			Math.floor( Math.log( bytesPerSec ) / Math.log( k ) )
		)
	);
	return compactFixed( bytesPerSec / Math.pow( k, i ) ) + ' ' + sizes[ i ];
}

/**
 * Compact count (K/M/B) for a message rate — e.g. 2996 → "3.0K/s".
 *
 * @param {number} perSec Messages per second.
 * @return {string} Formatted rate.
 */
export function formatMsgRate( perSec ) {
	if ( ! perSec || perSec === 0 ) {
		return '0/s';
	}
	const units = [ '', 'K', 'M', 'B' ];
	// Clamp the low end too: a fractional per-second rate (the overlay's In/Out)
	// floors to a negative index → units[-1] is undefined → "NaN/s".
	const i = Math.max(
		0,
		Math.min(
			units.length - 1,
			Math.floor( Math.log( perSec ) / Math.log( 1000 ) )
		)
	);
	return compactFixed( perSec / Math.pow( 1000, i ) ) + units[ i ] + '/s';
}

/**
 * Compact whole-count (K/M/B) for a 24h total — e.g. 1500 → "1.5K", 2000 → "2K".
 *
 * @param {number} n A count.
 * @return {string} Compacted count.
 */
export function formatCount( n ) {
	if ( ! Number.isFinite( n ) || n <= 0 ) {
		return '0';
	}
	if ( n < 1000 ) {
		return String( Math.round( n ) );
	}
	const units = [ '', 'K', 'M', 'B' ];
	let i = Math.min(
		units.length - 1,
		Math.floor( Math.log( n ) / Math.log( 1000 ) )
	);
	let value = compactFixed( n / Math.pow( 1000, i ) );
	// Rounding can push the value to 1000 (e.g. 999999 → "1000.0"); promote to the
	// next unit so it reads "1M", not "1000K".
	if ( value >= 1000 && i < units.length - 1 ) {
		i++;
		value = compactFixed( n / Math.pow( 1000, i ) );
	}
	return value + units[ i ];
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
