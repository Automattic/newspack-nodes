/**
 * The one spelling of a subject that rides on a command's FROM.
 *
 * A node asking about a subject appends it to FROM as ONE escaped address
 * segment. The server replies TO = FROM, and the Router peels the node's own
 * name off, so the reply reaches that node with the segment left as its
 * remaining TO (ADR-7): one node answers about many subjects, and nothing is
 * filed under anything. `FetcherNode`, `PollerNode` and `CommandResultNode`
 * all read and write it here.
 */

import { TO } from './message';

/**
 * The FROM a command about `subject` carries.
 *
 * @param {string}  name    The node the reply should reach.
 * @param {?string} subject What the command is about; null for nothing.
 * @return {string} `name`, or `name/<escaped subject>`.
 */
export function replyAddress( name, subject ) {
	return null === subject || undefined === subject
		? name
		: `${ name }/${ encodeURIComponent( subject ) }`;
}

/**
 * The subject a reply answers about, read off its remaining TO. A malformed
 * escape names no subject `replyAddress()` could have written, so it answers
 * no ask.
 *
 * @param {Array} message The reply as it reached the node that asked.
 * @return {?string} The subject as the sender named it, or null for none.
 */
export function replySubject( message ) {
	const path = message[ TO ];
	if ( 'string' !== typeof path || '' === path ) {
		return null;
	}
	try {
		return decodeURIComponent( path );
	} catch {
		return null;
	}
}
