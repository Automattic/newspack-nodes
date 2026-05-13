/**
 * Infer a PascalCase display TYPE for a substrate node name.
 *
 * The live `ls -al` output exposes only the registered name (e.g.
 * "firehose:tee", "request-builder"). Until the substrate gains an
 * `inspect <node>` verb that returns the actual class, we infer from
 * the segment after the colon (if present) or from the whole name,
 * splitting kebab-case / snake_case and re-joining as PascalCase to
 * match the substrate's actual class names: `Tee`, `Partition`,
 * `Consumer`, `RequestBuilder`, `JobRouter`, etc.
 *
 * Examples:
 *   firehose:tee       -> Tee
 *   firehose:consumer  -> Consumer
 *   request-builder    -> RequestBuilder
 *   jobs:partition     -> Partition
 *   stream_merger      -> StreamMerger
 *   sink               -> Sink
 */

export function inferType( name ) {
	if ( ! name || typeof name !== 'string' ) {
		return 'Node';
	}
	const colonIdx = name.lastIndexOf( ':' );
	const tail = colonIdx >= 0 ? name.slice( colonIdx + 1 ) : name;
	const parts = tail.split( /[-_]/ ).filter( Boolean );
	if ( ! parts.length ) {
		return 'Node';
	}
	return parts
		.map(
			( s ) => s.charAt( 0 ).toUpperCase() + s.slice( 1 ).toLowerCase()
		)
		.join( '' );
}
