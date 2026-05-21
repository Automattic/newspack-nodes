/**
 * Transform a Message envelope into the `{ p, line }` row RawLogs renders.
 *
 * @param {Array} envelope 7-field Message array.
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

	// Object/array VALUE → JSON; string VALUE passes through verbatim.
	let line = typeof value === 'string' ? value : JSON.stringify( value );

	const key = envelope[ KEY ];
	if ( typeof key === 'string' && key !== '' ) {
		line = `${ key }: ${ line }`;
	}

	if ( line.length > MAX_LINE_LENGTH ) {
		line = line.substring( 0, MAX_LINE_LENGTH ) + '...';
	}

	// Partition from the FROM stamp (`{sub}.pN`).
	const from = String( envelope[ FROM ] || '' );
	const match = from.match( PARTITION_RE );
	const p = match ? parseInt( match[ 1 ], 10 ) : 0;

	return { p, line };
}
