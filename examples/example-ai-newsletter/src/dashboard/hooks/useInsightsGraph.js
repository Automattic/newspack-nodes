/**
 * useInsightsGraph — mounts the Publisher Insights dashboard graph clipped onto
 * the canonical rule-#2 backbone (`_command_interpreter → _router`) via the
 * substrate's `_http` I/O boundary, plus the application's view-model node:
 *
 *   _http          (HttpOut — POST /command boundary; .client = CommandClient)
 *   insights:view  (the view-model node React reads + pending-Promise registry)
 *
 * EVERY node sinks into the interpreter; the router routes by TO. The `insights`
 * Service_CI verb returns the FULLY-SHAPED model synchronously in the POST body,
 * so there is NO transform node and NO SSE — the page-visibility-gated poll IS
 * the live data. The shared `useDashboardGraph` owns the exospine mount, the
 * `_http` boundary, the immediate + interval poll, and the page-visibility gate;
 * this hook just supplies its view node + poll command.
 *
 * The command boundary is injectable: tests pass `opts.commandClient` assigned
 * to `_http.client` so the hook never touches the network. Production lazily
 * defaults to the shared CommandClient over window.NewspackNodesData.
 */

import {
	newMessage,
	TYPE,
	FROM,
	TO,
	ID,
	VALUE,
	TM_COMMAND,
} from '@newspack-nodes/runtime';
import {
	useDashboardGraph,
	makeOpId,
} from '@newspack-nodes/shared/hooks/useDashboardGraph';
import '../nodes/register';

const HTTP = '_http';
const VIEW = 'insights:view';

/**
 * Build the `insights` TM_COMMAND: TO=`_http/insights` so the router peels
 * `_http` and HttpOut POSTs the bare command; FROM=`insights:view` is the reply
 * pivot (the CI replies TO=FROM, landing at the view).
 *
 * @param {string} id Correlator stamped into message[ID].
 * @return {Array} A 7-field positional Message.
 */
function buildInsightsCommand( id ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = VIEW;
	m[ TO ] = `${ HTTP }/insights`;
	m[ ID ] = id;
	m[ VALUE ] = { name: 'insights', arguments: '' };
	return m;
}

/**
 * @param {Object} [opts]               Options (test seams).
 * @param {Object} [opts.commandClient] CommandClient seam assigned to `_http.client`.
 * @param {number} [opts.refreshMs]     Poll interval in ms (default 4000).
 */
export function useInsightsGraph( opts = {} ) {
	const { commandClient, refreshMs = 4000 } = opts;
	useDashboardGraph( {
		mountNodes: ( interpreter ) =>
			interpreter.makeNode( 'InsightsView', VIEW ),
		poll: ( interpreter ) =>
			interpreter.fill(
				buildInsightsCommand( makeOpId( 'insights-op' ) )
			),
		refreshMs,
		commandClient,
	} );
}
