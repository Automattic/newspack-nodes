/**
 * Transform a Message envelope from the unified /messages/stream
 * endpoint into the `{ p, line }` row shape the RawLogs dashboard
 * renders. Mirror of the legacy `RawlogsController::transform_line()`
 * — moved client-side now that the unified endpoint passes through
 * parsed Message envelopes instead of the legacy `{p, line}` batch
 * shape.
 *
 * @param {Array} envelope 7-field Message array
 *                         `[TYPE, TIMESTAMP, FROM, TO, ID, KEY, VALUE]`.
 * @return {{p: number, line: string}|null} Row, or `null` if VALUE is empty.
 */
const FROM = 2;
const KEY = 5;
const VALUE = 6;

const MAX_LINE_LENGTH = 1000;
const PARTITION_RE = /\.p(\d+)$/;

export default function transformLogLine( envelope ) {
	const value = envelope[ VALUE ];
	if ( value === '' || value === null || value === undefined ) {
		return null;
	}

	// Object/array VALUE — render as JSON. String VALUE passes through
	// verbatim (matches the legacy server-side path that returned
	// `wp_json_encode( $body )` for arrays and the raw line otherwise).
	let line = typeof value === 'string' ? value : JSON.stringify( value );

	const key = envelope[ KEY ];
	if ( typeof key === 'string' && key !== '' ) {
		line = `${ key }: ${ line }`;
	}

	if ( line.length > MAX_LINE_LENGTH ) {
		line = line.substring( 0, MAX_LINE_LENGTH ) + '...';
	}

	// Partition from FROM stamp (`{sub}.pN`). The resolver in
	// Messages_Stream_Controller::open_subscription overrides the
	// Consumer stamp with this shape for log subscriptions.
	const from = String( envelope[ FROM ] || '' );
	const match = from.match( PARTITION_RE );
	const p = match ? parseInt( match[ 1 ], 10 ) : 0;

	return { p, line };
}
