/**
 * usePoller — one poller node mounted on the backbone for the life of a view,
 * asking its verb of `_cwd`, the scope the console draws, and handing back the
 * field it publishes.
 *
 * The node is a `Poller`, or a subclass such as `Metadata` that says what a
 * reply means. It rides the Router's grid at the live cadence
 * (`LIVE_POLL_INTERVAL_MS`), so a modal open on a worker keeps that worker's
 * stream from idling out, and its first poll goes in the Router tick the mount
 * asks for, beside everything else that tick sends. A `subject` rides on FROM,
 * so the reply comes back naming what it answers (ADR-7): the node publishes
 * only an answer about the subject it asks about now, and the hook hands back
 * a value only while the node standing asks about that subject. Any change to
 * what is asked mounts a fresh node.
 */

import { useCallback, useEffect, useState } from '@wordpress/element';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { LIVE_POLL_INTERVAL_MS } from '../../runtime/poller-node';
import { useNodeField } from '../../runtime/react';
import names from '../../runtime/reserved-node-names.json';
import {
	armTimer,
	pollTimerNow,
} from '@newspack-nodes/shared/helpers/armTimer';

/** The arguments a poll passes when it names none. */
const NO_ARGS = [];

/**
 * Mount a poller while `enabled`, and read what it publishes.
 *
 * @param {Object}   options
 * @param {string}   options.name        The node's registered name.
 * @param {string}   [options.nodeClass] The class `makeNode` builds: `Poller` by default.
 * @param {string}   options.verb        The verb it asks.
 * @param {string[]} [options.args]      The verb's argument tokens.
 * @param {string}   [options.field]     The field it publishes: `reply` by default.
 * @param {?string}  [options.subject]   What it asks about, ridden on FROM; null for none.
 * @param {boolean}  [options.enabled]   False mounts nothing. Default true.
 * @return {{ value: *, pollNow: () => void }} The field, null until the
 *   node standing answers about this subject, and a call that polls again
 *   inside the next Router tick.
 */
export function usePoller( {
	name,
	nodeClass = 'Poller',
	verb,
	args = NO_ARGS,
	field = 'reply',
	subject = null,
	enabled = true,
} ) {
	/**
	 * Bumped once the node exists, so `useNodeField` re-resolves it: on the
	 * render that mounts it, nothing by that name was registered yet.
	 */
	const [ , bumpBuild ] = useState( 0 );
	const argsKey = JSON.stringify( args );

	useEffect( () => {
		if ( ! enabled ) {
			return undefined;
		}
		const build = ( { interpreter } ) => {
			// `_cwd` routes to the current scope; default it to browser-local.
			if ( ! Core.node( names.CWD ) ) {
				interpreter.makeNode( 'Node', names.CWD );
			}
			const poller = interpreter.makeNode( nodeClass, name );
			poller.verb = verb;
			poller.pollArgs = JSON.parse( argsKey );
			poller.subject = subject;
			poller.target = names.CWD;
			poller.pollIntervalMs = LIVE_POLL_INTERVAL_MS;
			armTimer( poller, LIVE_POLL_INTERVAL_MS );
			bumpBuild( ( n ) => n + 1 );
		};
		const { teardown } = mountExospine( build );
		return teardown;
	}, [ enabled, name, nodeClass, verb, argsKey, subject ] );

	const pollNow = useCallback( () => {
		const poller = Core.node( name );
		if ( poller ) {
			pollTimerNow( poller );
		}
	}, [ name ] );

	// Only the re-render: the value is read off the live node below.
	useNodeField( name, field );
	// @longform Value and subject come off the one node standing now, so a
	// render between a switch and the new node's first answer cannot pair the
	// last node's value with the new subject.
	const standing = Core.node( name );
	const current = enabled && standing?.subject === subject;
	return { value: current ? standing?.[ field ] ?? null : null, pollNow };
}
