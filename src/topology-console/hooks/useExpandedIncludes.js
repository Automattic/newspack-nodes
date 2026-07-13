/**
 * useExpandedIncludes — the composed baseline for the draft's include set.
 *
 * One `topologies expand` round trip per include-set change (none at all when
 * the set is empty). A cycle/conflict/unknown-name throws server-side; we keep
 * the last-good baseline and surface the message so the caller can revert.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { getCommandClient } from '../utils/commandClient';
import unwrapCommandResponse from '../utils/unwrapCommandResponse';

const EMPTY = { nodes: [], edges: [], tree: {} };

export function useExpandedIncludes( includes ) {
	const key = ( includes || [] ).join( ' ' );
	const [ state, setState ] = useState( {
		baseline: EMPTY,
		error: null,
		loading: false,
	} );
	const lastKey = useRef( null );

	useEffect( () => {
		if ( '' === key ) {
			lastKey.current = key;
			setState( { baseline: EMPTY, error: null, loading: false } );
			return undefined;
		}
		if ( lastKey.current === key ) {
			return undefined;
		}
		lastKey.current = key;
		let cancelled = false;
		setState( ( s ) => ( { ...s, loading: true, error: null } ) );
		getCommandClient()
			.send( { to: 'topologies', verb: 'expand', args: key } )
			.then( ( message ) => {
				if ( cancelled ) {
					return;
				}
				const value = unwrapCommandResponse( message );
				setState( {
					baseline: {
						nodes: value.nodes || [],
						edges: value.edges || [],
						tree: value.tree || {},
					},
					error: null,
					loading: false,
				} );
			} )
			.catch( ( e ) => {
				if ( cancelled ) {
					return;
				}
				setState( ( s ) => ( {
					baseline: s.baseline,
					error: e?.message || 'expand failed',
					loading: false,
				} ) );
			} );
		return () => {
			cancelled = true;
		};
	}, [ key ] );

	return state;
}
