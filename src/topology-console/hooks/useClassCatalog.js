/**
 * useClassCatalog — the substrate class catalog behind the palette, as a
 * batched-poll slice.
 *
 * It used to memoise the in-flight promise forever, so a catalog that failed
 * once stayed failed: every later load() handed back the same rejected promise
 * and the palette was empty until a reload. The overnight tab hit exactly that
 * — the catalog loaded fine at mount, the session expired an hour later, and
 * nothing ever asked again.
 *
 * A slice has no promise to memoise and no cache to invalidate. The tick asks
 * again, so a turned-over session recovers on its own, and the auth-generation
 * stamp that used to guard the cache has nothing left to guard.
 */

import { useNodeState } from '../../runtime/react';
import { useBatchedPoll } from '@newspack-nodes/shared/hooks/useBatchedPoll';
import { addSliceFetcher } from '@newspack-nodes/shared/helpers/addSliceFetcher';
import names from '../../runtime/reserved-node-names.json';
import '../nodes/register';

const FETCHER = 'classes:fetch';
const RECEIVER = 'classes:in';
const VIEW = 'classes:view';

/** Every router tick; batched, it costs no request of its own. */
const POLL_INTERVAL_MS = 1000;

const EMPTY = { classes: null, formatters: [], error: null };

/**
 * @param {Object}  [options]         Hook options.
 * @param {boolean} [options.enabled] Gate — false costs no request at all, so a
 *                                    palette that is never opened is free.
 * @return {{classes: Object[], formatters: string[], loading: boolean, error: ?string}}
 *   Catalog state. `classes` are the palette entries from `classes list` (one
 *   per concrete Node class, schema inlined), `formatters` their registered
 *   formatter names. Consumers READ these; there is nothing to call. The
 *   `load()` promise they used to await was the last thing standing between the
 *   palette and its slice.
 */
export function useClassCatalog( { enabled = false } = {} ) {
	useBatchedPoll( {
		build: ( { interpreter, tee } ) =>
			addSliceFetcher( interpreter, {
				fetcher: FETCHER,
				receiver: RECEIVER,
				command: 'list',
				view: VIEW,
				viewClass: 'ClassCatalogView',
				tee,
				target: `${ names.CONSOLE_TAP }/${ names.HTTP }/classes`,
			} ),
		timerName: 'classes:timer',
		teeName: 'classes:tee',
		enabled,
		intervalMs: POLL_INTERVAL_MS,
	} );

	const model = useNodeState( VIEW, 'view' ) ?? EMPTY;
	const classes = model.classes ?? [];
	const formatters = model.formatters ?? [];

	return {
		classes,
		formatters,
		loading: enabled && null === model.classes && ! model.error,
		error: model.error ?? null,
	};
}
