/**
 * useTopologyList — the catalog of saved topologies, as a batched-poll slice.
 *
 * A refused fetch used to leave the OPEN dialog permanently empty, and a save
 * owed the catalog an explicit `reload()`. The poll owes it nothing: the next
 * tick carries the new entry, and a refusal is simply a tick that published
 * nothing. `reload()` survives as a no-op so the save and delete paths read as
 * they did — there is nothing left for them to trigger.
 */

import { useCallback } from '@wordpress/element';
import { useNodeState } from '../../runtime/react';
import { useBatchedPoll } from '@newspack-nodes/shared/hooks/useBatchedPoll';
import { useCommandOnce } from '@newspack-nodes/shared/hooks/useCommandOnce';
import { addSliceFetcher } from '@newspack-nodes/shared/helpers/addSliceFetcher';
import { formatCommandArgs } from '../../runtime/command-args';
import names from '../../runtime/reserved-node-names.json';
import '../nodes/register';

const LIST_FETCHER = 'topologies:list:fetch';
const LIST_RECEIVER = 'topologies:list:in';
const LIST_VIEW = 'topologies:list:view';

/** Every router tick; batched, it costs no request of its own. */
const POLL_INTERVAL_MS = 1000;

const EMPTY_LIST = { topologies: null, userDir: '', error: null };

/**
 * Poll the saved-topology catalog and publish it as a slice.
 *
 * @param {Object}  [o]         Options.
 * @param {boolean} [o.enabled] False costs no request, so a closed dialog is free.
 * @return {{topologies: Object[], userDir: string, loading: boolean, error: string|null, reload: Function}}
 *   `topologies` are the catalog entries (`name`, `source`, `active`,
 *   `num_partitions`, `frontmatter`); `userDir` is the writable topology
 *   directory, empty when none is configured; `reload()` is a no-op the poll
 *   made redundant.
 */
export function useTopologyList( { enabled = false } = {} ) {
	useBatchedPoll( {
		build: ( { interpreter, tee } ) =>
			addSliceFetcher( interpreter, {
				fetcher: LIST_FETCHER,
				receiver: LIST_RECEIVER,
				command: 'list',
				view: LIST_VIEW,
				viewClass: 'TopologyListView',
				tee,
				target: `${ names.CONSOLE_TAP }/${ names.HTTP }/topologies`,
			} ),
		timerName: 'topologies:list:timer',
		teeName: 'topologies:list:tee',
		enabled,
		intervalMs: POLL_INTERVAL_MS,
	} );

	const model = useNodeState( LIST_VIEW, 'view' ) ?? EMPTY_LIST;

	// The tick already carries a save's new entry; nothing to trigger.
	const reload = useCallback( () => {}, [] );

	return {
		topologies: model.topologies ?? [],
		userDir: model.userDir,
		loading: enabled && null === model.topologies && ! model.error,
		error: model.error ?? null,
		reload,
	};
}

/**
 * useTopology — one topology's TSL body, on demand.
 *
 * The awaited `fetchTopology( name )` it used to return was a POST of its own,
 * minted from a React callback and therefore outside the router's lock/flush
 * bracket. It is a one-shot READ now: `open( name )` names what is wanted, the
 * tick asks for it, and the answer arrives as published state.
 *
 * Being a read, it retries — an unanswered ask is what leaves an editor open on
 * half a page. Being answered is what stops it, refusal included, so a topology
 * that does not exist costs one command rather than one per second.
 *
 * @param {Object}  o           Options.
 * @param {string}  o.scope     Names this reader's own slice. Two readers
 *                              wanting two different topologies are two slices,
 *                              never one node demultiplexing — see ADR-7.
 * @param {boolean} [o.enabled] False ignores `open()` entirely.
 * @return {{open: (name: string) => void, topology: ?Object, loading: boolean, error: ?string}}
 *   `open()` requests a topology by name; `topology` is the answer to the most
 *   recent `open()` and null until it lands, so a caller reads it as "mine".
 */
export function useTopology( { scope, enabled = true } ) {
	const { run, result, error, pending } = useCommandOnce( {
		ci: 'topologies',
		command: 'get',
		scope: `topologies:get:${ scope }`,
		retry: true,
	} );

	const open = useCallback(
		( name ) => {
			if ( enabled && name ) {
				run( formatCommandArgs( [ name ] ) );
			}
		},
		[ enabled, run ]
	);

	return {
		open,
		// While a newer ask is outstanding the previous answer is not "mine".
		topology: pending ? null : result,
		loading: pending,
		error,
	};
}
