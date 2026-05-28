/**
 * `rawlogs:route` — the classifier that makes the data/control split a
 * first-class, inspectable node instead of a bespoke `controlSink` edge.
 *
 * It receives everything `rawlogs:stream` emits (sink = the CI, like every
 * exospine node) and stamps `TO` per class: a connection-status control
 * (the stream stamps `KEY = 'connection'`) → the view, every other (data log)
 * envelope → the transform. Classification keys off the stream-set KEY, NOT
 * VALUE content — an arbitrary streamed TM_STRUCT log line may legitimately
 * carry a `VALUE.action` field, so keying on VALUE would misroute real data.
 * Its data target is the node `target` (so the hop shows in `ls -t`); the
 * control target is a sibling field a `dump_node` exposes.
 */

import { Node } from '../../runtime/node';
import { TO, KEY } from '../../runtime/message';

// The KEY marker the stream stamps on a synthesized connection-status control.
// Wire log envelopes carry a partition/offset KEY (e.g. '5:100'), never this.
const CONTROL_KEY = 'connection';

class RawLogsRouteNode extends Node {
	constructor( dataTarget, controlTarget ) {
		super();
		// Data → transform via the normal target mechanism (visible in `ls -t`).
		this.target = dataTarget;
		// Control (connection status) → view, skipping the transform.
		this.controlTarget = controlTarget;
	}

	fill( message ) {
		this.counter += 1;
		const isControl = CONTROL_KEY === message[ KEY ];
		message[ TO ] = isControl ? this.controlTarget : this.target;
		if ( this.sink ) {
			this.sink.fill( message );
		}
	}
}

/**
 * Create and register the Raw Logs route node.
 *
 * @param {string} name                  Node name.
 * @param {Object} targets               Class targets.
 * @param {string} targets.dataTarget    Where data log envelopes route.
 * @param {string} targets.controlTarget Where connection-status controls route.
 * @return {RawLogsRouteNode} The route node.
 */
export function createRawLogsRoute( name, { dataTarget, controlTarget } ) {
	const node = new RawLogsRouteNode( dataTarget, controlTarget );
	node.setName( name );
	return node;
}
