/**
 * Compact byte size for the log-browser meta column — one decimal place,
 * B / KB / MB. The ONE formatter both log-stream sidebars (Partition Viewer
 * segments, Log Viewer segments) render their size meta with.
 *
 * @param {number} bytes Byte count.
 * @return {string} Formatted size.
 */
export default function formatBytes( bytes ) {
	if ( ! bytes ) {
		return '0 B';
	}
	if ( bytes < 1024 ) {
		return `${ bytes } B`;
	}
	if ( bytes < 1024 * 1024 ) {
		return `${ ( bytes / 1024 ).toFixed( 1 ) } KB`;
	}
	return `${ ( bytes / ( 1024 * 1024 ) ).toFixed( 1 ) } MB`;
}
