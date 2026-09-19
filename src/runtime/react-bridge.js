/**
 * `ReactBridge` — what a node takes on when React reads its structured
 * output: a view model, the transcript, the metadata tree.
 *
 * `Node` is the Tachikoma port, and neither PHP's `Node` nor Tachikoma's holds
 * structured output for a UI, so the two pieces that serve one live here
 * instead. `setField()` publishes a field and announces it for
 * `useNodeField()`; `dumpOmits` names the bulk fields `dump_node` leaves out,
 * which would otherwise bury the node's state under its payload.
 *
 * Mix it in once, at the highest class that publishes a field: a subclass of a
 * bridged class inherits both.
 */

/**
 * Every field `dump_node` leaves out for a class: each level's own
 * `dumpOmits`, merged down the prototype chain, so a class lists only the bulk
 * it adds.
 *
 * @param {*} ctor The node's class; each level may declare `dumpOmits`.
 * @return {Set<string>} The fields to leave out.
 */
function dumpOmitsOf( ctor ) {
	const omits = new Set();
	for (
		let level = ctor;
		level && level !== Function.prototype;
		level = Object.getPrototypeOf( level )
	) {
		if ( Object.hasOwn( level, 'dumpOmits' ) ) {
			level.dumpOmits.forEach( ( field ) => omits.add( field ) );
		}
	}
	return omits;
}

/**
 * Mix the React bridge into a node class.
 *
 * @template {new ( ...args: any[] ) => import('./node').Node} T
 * @param {T} Base The node class to extend; the result adds `setField()` and
 *                 `dumpOmits` support.
 */
export const ReactBridge = ( Base ) =>
	class extends Base {
		/**
		 * Replace a structured field and announce it. The announcement carries
		 * no payload — TM_INFO carries strings, so the object never reaches a
		 * node-name listener — and a listener reads the field off the node.
		 *
		 * @param {string} field Field name, and the pre-declared event it notifies.
		 * @param {*}      value The field's new value.
		 */
		setField( field, value ) {
			this[ field ] = value;
			this.notify( field );
		}

		/**
		 * `Node.dumpNode()`, leaving out every field the class chain names in
		 * `dumpOmits` — unread, so a ring or a transcript is never copied —
		 * except one `keys` asks for, which `dump_node <name> <key>` returns
		 * whole.
		 *
		 * @param {Object}      [options]      Snapshot options.
		 * @param {string[]}    [options.keys] Fields asked for by name.
		 * @param {Set<string>} [options.skip] Further fields to leave out.
		 * @return {Object} Field names to their displayable values.
		 */
		dumpNode( { keys = [], skip = new Set() } = {} ) {
			const omits = dumpOmitsOf( this.constructor );
			keys.forEach( ( key ) => omits.delete( key ) );
			skip.forEach( ( key ) => omits.add( key ) );
			return super.dumpNode( { skip: omits } );
		}
	};
