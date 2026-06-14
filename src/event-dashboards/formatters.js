/**
 * Shared presentation formatters for the event dashboards (bytes, rates, age, ETA).
 */

import { __ } from '@wordpress/i18n';

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
	return (
		parseFloat( ( bytes / Math.pow( k, i ) ).toFixed( 1 ) ) +
		' ' +
		sizes[ i ]
	);
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
	const i = Math.floor( Math.log( bytesPerSec ) / Math.log( k ) );
	return (
		parseFloat( ( bytesPerSec / Math.pow( k, i ) ).toFixed( 1 ) ) +
		' ' +
		sizes[ i ]
	);
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
 * Format ETA as human readable duration.
 *
 * @param {number} bytesBehind Bytes remaining to process.
 * @param {number} readRate    Current read rate in bytes per second.
 * @return {string} Formatted ETA string or empty if not applicable.
 */
export function formatEta( bytesBehind, readRate ) {
	if ( ! bytesBehind || bytesBehind <= 0 ) {
		return '';
	}
	if ( ! readRate || readRate <= 0 ) {
		return __( 'stalled', 'newspack-nodes' );
	}
	const seconds = Math.ceil( bytesBehind / readRate );
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
