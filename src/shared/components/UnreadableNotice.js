/**
 * The error a view shows for each failure the server answered beside a
 * partial reply. `dump_graph` and the aggregator's `summary` read every
 * active topology that reads and name each one that does not, with its
 * message, so one broken `.tsl` costs its own rows; `dump_graph` names each
 * log producer its catalog left out the same way. Carried and never shown,
 * such a failure reads as a fleet that simply has less in it.
 *
 * One banner per failure, each wearing the canonical
 * `newspack-nodes-error-banner` role and declaring no appearance of its own.
 * `role="status"` makes each a polite live region, as `ConnectionBanner` is:
 * a failure that clears on the next poll must not interrupt the reader.
 *
 * @param {Object}                                    props
 * @param {Object<string,string>|Array|undefined}     props.failures Name => message. PHP encodes an empty map as `[]`, which renders nothing.
 * @param {(name: string, message: string) => string} props.describe The translated sentence for one failure.
 * @return {import('react').ReactElement[]} One banner per failure; none when nothing failed.
 */
export default function UnreadableNotice( { failures, describe } ) {
	return Object.entries( failures ?? {} ).map( ( [ name, message ] ) => (
		<div key={ name } className="newspack-nodes-error-banner" role="status">
			{ describe( name, message ) }
		</div>
	) );
}
