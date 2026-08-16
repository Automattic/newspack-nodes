/**
 * mockCommandOnce — a `useCommandOnce` double that answers on demand.
 *
 * A surface whose verbs are its OWN one-shots has no graph in a unit test, and
 * standing the whole wire up costs a router tick per assertion. This records
 * each verb by scope and hands the test `answerCommand`, which fires that
 * verb's own `onDone` — the same callback the real reply lands in, so the path
 * under test is the real one and only the wire is stood in for.
 *
 *     jest.mock( '@newspack-nodes/shared/hooks/useCommandOnce', () =>
 *         require( '@newspack-nodes/shared/test-utils/mockCommandOnce' ).factory()
 *     );
 *
 * @package
 */

import { useEffect, useState } from '@wordpress/element';

/** Every registered verb, by scope. @testonly */
export const commands = {};

const IDLE = {
	result: null,
	error: null,
	errorData: null,
	answeredArgs: null,
	pending: false,
};

/**
 * What `useCommandOnce` returns for one scope, built once and kept.
 *
 * `run` must be STABLE across renders, as the real `useCallback` one is: an
 * unstable identity re-runs every effect that lists it as a dependency, which
 * is a live bug this double would otherwise hide.
 *
 * @param {string} key The scope.
 * @return {Object} The entry.
 */
function entryFor( key ) {
	commands[ key ] ??= {
		sent: [],
		listeners: new Set(),
		api: {
			...IDLE,
			run: ( args ) => {
				const entry = commands[ key ];
				entry.sent.push( args );
				publish( key, { pending: true } );
			},
		},
	};
	return commands[ key ];
}

/**
 * Move a verb's published state and re-render whoever is reading it — which
 * is what makes this behave like the hook rather than a frozen snapshot.
 *
 * @param {string} key    The scope.
 * @param {Object} fields The fields to move.
 */
function publish( key, fields ) {
	const entry = commands[ key ];
	entry.api = { ...entry.api, ...fields };
	entry.listeners.forEach( ( bump ) => bump( ( n ) => n + 1 ) );
}

/**
 * The module shape a `jest.mock` factory returns.
 *
 * @return {Object} `{ __esModule, useCommandOnce }`.
 */
export function factory() {
	return {
		__esModule: true,
		useCommandOnce: ( opts ) => {
			const key =
				opts.scope ||
				`${ opts.ci ? `${ opts.ci }:` : '' }${ opts.command }`;
			const entry = entryFor( key );
			entry.opts = opts;
			// A real hook re-renders its reader when its answer moves.
			const [ , bump ] = useState( 0 );
			useEffect( () => {
				entry.listeners.add( bump );
				return () => entry.listeners.delete( bump );
			}, [ entry ] );
			return entry.api;
		},
	};
}

/**
 * Deliver a reply to the verb registered under `key`.
 *
 * @param {string}   key    Scope, or `<ci>:<command>`.
 * @param {Object}   answer `{ result, error, errorData, args }`, as `onDone` takes it.
 * @param {Function} run    The test's `act`, so React flushes the update.
 */
export function answerCommand( key, answer, run ) {
	const entry = commands[ key ];
	if ( ! entry ) {
		throw new Error(
			`no command registered for ${ key } (have: ${ Object.keys(
				commands
			).join( ', ' ) })`
		);
	}
	const reply = {
		result: null,
		error: null,
		errorData: null,
		args: entry.sent[ entry.sent.length - 1 ] ?? [],
		...answer,
	};
	const deliver = () => {
		publish( key, {
			result: reply.result,
			error: reply.error,
			errorData: reply.errorData,
			answeredArgs: reply.args,
			pending: false,
		} );
		entry.opts.onDone?.( reply );
	};
	return run ? run( deliver ) : deliver();
}

/**
 * What a verb was asked, most recent last.
 *
 * @param {string} key Scope, or `<ci>:<command>`.
 * @return {Array[]} The argument arrays it was run with.
 */
export const sentTo = ( key ) => commands[ key ]?.sent ?? [];

/** Forget every registered verb. Call between tests. @testonly */
export function resetCommands() {
	Object.keys( commands ).forEach( ( k ) => delete commands[ k ] );
}
