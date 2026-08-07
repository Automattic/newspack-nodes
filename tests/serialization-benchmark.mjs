/**
 * Serialization throughput benchmark, JS side — the counterpart to
 * `tests/serialization-benchmark.php`, itself a port of Tachikoma's
 * `examples/benchmarks/serialization`.
 *
 * Sweeps payload sizes 64B -> 1MB (x4) and measures `pack()` and `unpack()`
 * throughput at each size, in the same shape and output format as the PHP one
 * so the two can be read side by side.
 *
 * Run it directly:
 *   node tests/serialization-benchmark.mjs
 *
 * It bundles `src/runtime/message.js` through esbuild first: this package has
 * no `"type": "module"`, so Node reads a bare `.js` as CommonJS and refuses the
 * ESM source. Bundling to a data: URL keeps it a one-command run with no temp
 * file, and measures the REAL runtime functions rather than a transcription.
 *
 * Timing-driven, no assertions — not a jest test.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname( fileURLToPath( import.meta.url ) );
const TOTAL = 10000;
const DELAY = 1;
const MAX_BUF = 1048576;

const bundled = await build( {
	entryPoints: [ resolve( HERE, '../src/runtime/message.js' ) ],
	bundle: true,
	format: 'esm',
	platform: 'node',
	write: false,
} );
const { pack, unpack, newMessage, TYPE, VALUE, TM_BYTESTREAM } = await import(
	'data:text/javascript;base64,' +
		Buffer.from( bundled.outputFiles[ 0 ].text ).toString( 'base64' )
);

/** A TM_BYTESTREAM message with an empty VALUE. */
function baseMessage() {
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	return m;
}

/**
 * MB/s and msg/s for one leg, formatted as the PHP benchmark formats it.
 *
 * @param {string} type  'pack' or 'unpack'.
 * @param {number} count Messages processed.
 * @param {number} size  Packed bytes per message.
 * @param {number} span  Seconds elapsed.
 */
function report( type, count, size, span ) {
	const mb = ( ( count * size ) / 1024 / 1024 / span ).toFixed( 2 );
	const per = ( count / span ).toFixed( 2 );
	console.log(
		`${ type.padStart( 6 ) } ${ mb } MB per second - ${ per } messages per second`
	);
}

/**
 * Run one leg until at least DELAY seconds have elapsed, checking the clock
 * every TOTAL iterations so the timing call itself stays out of the hot loop.
 *
 * @param {string}   type Label for the report line.
 * @param {Function} once Zero-arg closure performing one operation.
 * @param {number}   size Packed bytes per message.
 */
function measure( type, once, size ) {
	let check = 0;
	let count = 0;
	const then = performance.now();
	for (;;) {
		once();
		if ( check++ >= TOTAL ) {
			const span = ( performance.now() - then ) / 1000;
			count += check;
			if ( span >= DELAY ) {
				report( type, count, size, span );
				return;
			}
			check = 0;
		}
	}
}

for ( let bufSize = 64; bufSize <= MAX_BUF; bufSize *= 4 ) {
	const message = baseMessage();
	// Measured, not assumed: the JSON envelope plus a real timestamp is not a
	// fixed width, so subtract what an empty VALUE actually costs.
	const overhead = Buffer.byteLength( pack( message ) );
	// '.' is one unescaped byte; a NUL would balloon to a 6-char escape and
	// turn the sweep into an escape-bloat test instead.
	message[ VALUE ] = '.'.repeat( Math.max( 1, bufSize - overhead ) );

	const packed = pack( message );
	const size = Buffer.byteLength( packed );
	console.log( `\nsize: ${ size }` );
	measure( 'pack', () => pack( message ), size );
	measure( 'unpack', () => unpack( packed ), size );
}
