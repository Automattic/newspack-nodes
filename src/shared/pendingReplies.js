/**
 * Shared request/reply correlation for dashboard view nodes.
 *
 * Several view nodes await a verb's reply by stashing a `{ resolve, reject }`
 * keyed by `message[ID]`, then settling it when the matching reply pivots back
 * (TO=FROM). `PendingReplies` owns that Map; `errorMessage` is the TM_ERROR
 * payload coercion they all share. Canonical shared module; sibling plugins
 * consume it via the `@newspack-nodes/shared` alias (esbuild + jest), not a copy.
 */

import { ID, TYPE, VALUE, TM_ERROR } from '@newspack-nodes/runtime';

/**
 * Coerce a TM_ERROR payload (string / { message } / anything else) to a
 * human-readable string.
 *
 * @param {*} payload The reply's VALUE.payload.
 * @return {string} The readable message; 'Operation failed' as a last resort.
 */
export function errorMessage( payload ) {
	if ( 'string' === typeof payload && payload.length > 0 ) {
		return payload;
	}
	if (
		payload &&
		'object' === typeof payload &&
		'string' === typeof payload.message &&
		payload.message.length > 0
	) {
		return payload.message;
	}
	return 'Operation failed';
}

/**
 * A correlation registry: stash a Promise's resolvers under an outbound
 * message's ID, settle it when the matching reply arrives.
 */
export class PendingReplies {
	constructor() {
		this._map = new Map();
	}

	/**
	 * Settle the entry matching `message[ID]`: reject with an Error on TM_ERROR,
	 * else resolve with the reply's VALUE.payload. The boolean lets a caller
	 * either return early or gate a global-error path on whether it matched.
	 *
	 * @param {Array} message A 7-field positional Message.
	 * @return {boolean} True if an entry was settled; false if none matched.
	 */
	settle( message ) {
		const id = message[ ID ];
		if ( ! id || ! this._map.has( id ) ) {
			return false;
		}
		const { resolve, reject } = this._map.get( id );
		this._map.delete( id );
		const value = message[ VALUE ];
		const payload = value?.payload;
		if ( 0 !== ( ( message[ TYPE ] || 0 ) & TM_ERROR ) ) {
			reject( new Error( errorMessage( payload ) ) );
		} else {
			resolve( payload );
		}
		return true;
	}

	/**
	 * @param {string} id Correlator.
	 * @return {boolean} Whether an entry is stashed under `id`.
	 */
	has( id ) {
		return this._map.has( id );
	}

	/**
	 * Stash a Promise's resolvers under `id` (the outbound message[ID]).
	 *
	 * @param {string}   id      Correlator.
	 * @param {Function} resolve Promise resolver.
	 * @param {Function} reject  Promise rejecter.
	 */
	add( id, resolve, reject ) {
		this._map.set( id, { resolve, reject } );
	}

	get size() {
		return this._map.size;
	}

	/**
	 * Reject every in-flight entry and empty the map. For node teardown, so a
	 * graph reinit doesn't strand a caller awaiting a reply that will never land
	 * on this (removed) node.
	 *
	 * @param {string} reason The rejection Error message.
	 */
	rejectAll( reason ) {
		for ( const { reject } of this._map.values() ) {
			if ( 'function' === typeof reject ) {
				reject( new Error( reason ) );
			}
		}
		this._map.clear();
	}
}
