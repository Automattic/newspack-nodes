/**
 * useSettingsAuditStream — mounts a single substrate `RemoteLink` onto the
 * canonical backbone (`_command_interpreter → _router`) tailing the shared
 * `settings.p0` log, feeding a `settingsaudit:view` view-model node:
 *
 *   settingsaudit:link   (RemoteLink — composes SseIn/HttpOut/Heartbeat + slot bridge)
 *   settingsaudit:view   (SettingsAuditView — option-name change timeline)
 *
 * There is only one seek: positions=start. Config Audit is a TIMELINE, so it
 * always replays the full retained history (~1 day, `Settings_Event_Writer`
 * geometry) then follows live. A visibility-driven RECONNECT resumes from the last
 * seen offset (`link.resumePositions()`) so a hidden gap fills exactly — no dropped
 * span, no re-replay of the whole log.
 *
 * React reads the model via `useNodeState('settingsaudit:view','view')`.
 */

import usePageVisibility from '@newspack-nodes/shared/hooks/usePageVisibility';
import { useVisibilityGatedLink } from '@newspack-nodes/shared/hooks/useVisibilityGatedLink';
import { CommandClient } from '../../runtime/command-client';
import '../nodes/register';

const LINK = 'settingsaudit:link';
const TEE = 'settingsaudit:stream';
const VIEW = 'settingsaudit:view';
// Explicit .p0 hits the no-worker log-feed fallback (settings is 1-part).
const SUBSCRIBE = 'settings.p0';

/**
 * @param {Object} [opts]
 * @param {Object} [opts.commandClient] CommandClient seam for the link's HttpOut.
 */
export function useSettingsAuditStream( { commandClient } = {} ) {
	const isPageVisible = usePageVisibility();

	// Shared lifecycle owns close-while-hidden + resume-on-refocus.
	useVisibilityGatedLink( {
		mountNodes: ( interpreter ) => {
			// baseUrl/nonce resolve from the localized global, not tokens.
			const link = interpreter.makeNode( 'RemoteLink', LINK, [
				SUBSCRIBE,
			] );
			// Pass-through stream Tee; copies frames to the view.
			link.target = TEE;
			link.client = commandClient || CommandClient.fromGlobal();

			const tee = interpreter.makeNode( 'Tee', TEE );
			tee.connectNode( VIEW );

			interpreter.makeNode( 'SettingsAuditView', VIEW );
			return { link };
		},
		isActive: isPageVisible,
		// Always full replay; a reconnect resumes from the last seen offset.
		onConnect: ( link, { isReconnect } ) =>
			link.connect(
				isReconnect
					? link.resumePositions()
					: { [ SUBSCRIBE ]: 'start' }
			),
	} );
}
