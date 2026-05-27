import { Callback } from '../../runtime/callback';
import {
	KEY,
	TO,
	VALUE,
	TYPE,
	TM_STRUCT,
	newMessage,
} from '../../runtime/message';
import transformLogLine from '../transformLogLine';

/**
 * `rawlogs:transform` — turn a log SSE envelope into a `{ p, line }` row.
 *
 * Drops the `connected` sentinel and any envelope `transformLogLine` rejects,
 * then emits a fresh TM_STRUCT row message through its sink (the exospine CI)
 * stamped `TO = target` (→ `rawlogs:view`). Callback doesn't forward, so the
 * closure stamps + pushes to `node.sink` itself.
 *
 * @param {string} name Node name.
 * @return {Callback} The transform node.
 */
export function createRawLogsTransform( name ) {
	const node = new Callback( ( envelope ) => {
		if ( 'connected' === envelope[ KEY ] ) {
			return;
		}
		const row = transformLogLine( envelope );
		if ( ! row ) {
			return;
		}
		if ( ! node.sink ) {
			return;
		}
		const out = newMessage();
		out[ TYPE ] = TM_STRUCT;
		out[ TO ] = node.target;
		out[ VALUE ] = { p: row.p, line: row.line };
		node.sink.fill( out );
	} );
	node.setName( name );
	return node;
}
