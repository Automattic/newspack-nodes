// WCAG contrast ratio. Usage: node tools/contrast.mjs "#1e1e1e" "#ffffff"
const hex = ( h ) => {
	const s = h.replace( '#', '' );
	const n = s.length === 3 ? s.split( '' ).map( ( c ) => c + c ).join( '' ) : s;
	return [ 0, 2, 4 ].map( ( i ) => parseInt( n.slice( i, i + 2 ), 16 ) / 255 );
};
const lin = ( c ) => ( c <= 0.03928 ? c / 12.92 : ( ( c + 0.055 ) / 1.055 ) ** 2.4 );
const lum = ( rgb ) => 0.2126 * lin( rgb[ 0 ] ) + 0.7152 * lin( rgb[ 1 ] ) + 0.0722 * lin( rgb[ 2 ] );
const [ a, b ] = process.argv.slice( 2 ).map( hex );
const [ L1, L2 ] = [ lum( a ), lum( b ) ].sort( ( x, y ) => y - x );
console.log( ( ( L1 + 0.05 ) / ( L2 + 0.05 ) ).toFixed( 2 ) );
