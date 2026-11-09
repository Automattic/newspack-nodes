/**
 * useComposition — one context's layout over the `compositions` service.
 *
 * Mounting reads the layout fresh (`compositions get`), never trusting what a
 * page carried, which another editor's save may have outdated. `save()` and
 * `restore()` are writes: each goes exactly once, still goes when the page is
 * left, and its reply is the layout the context now reads. Three commands,
 * three Fetchers, so no reply needs telling apart (ADR-7).
 *
 * The reader half of the composition layer: `save()` takes markup the editor
 * serialized, so this module imports no block library.
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { useCommandOnce } from '../hooks/useCommandOnce';
import { formatCommandArgs } from '../../runtime/command-args';

/** The server CI the three commands live on. */
const COMPOSITIONS_CI = 'compositions';

/**
 * The layout a context reads, as `compositions` answers it.
 *
 * @typedef {Object} CompositionAnswer
 * @property {string}                                        context  The context.
 * @property {'saved'|'default'}                             source   Which layout it reads.
 * @property {import('./CompositionView').CompositionNode[]} blocks   Its tree.
 * @property {?number}                                       saved_ts When its record was written.
 * @property {?string}                                       actor    Who wrote it.
 */

/**
 * Mounts a context's three commands and reads its layout.
 *
 * @param {string}                                            group       The surface sending them, whose `<group>:shell` Tap they pass.
 * @param {string}                                            context     A declared context, `<namespace>/<name>`.
 * @param {(answer: CompositionAnswer, verb: string) => void} [onWritten] Runs once per write the server took, with the
 *                                                                        layout it answered and `save` or `restore`.
 * @return {{answer: ?CompositionAnswer, error: ?string, loading: boolean, save: (markup: string) => void, restore: () => void, refusal: ?string, writing: boolean}}
 *   `answer` is the last layout any of the three answered; `error` the read's
 *   refusal; `refusal` the last write's; `writing` holds while a write waits.
 */
export function useComposition( group, context, onWritten ) {
	// A node name never holds `/`, which routes; a namespace never holds `:`.
	const scope = `${ COMPOSITIONS_CI }:${ context.replaceAll( '/', ':' ) }`;
	const [ answer, setAnswer ] = useState( null );
	const [ refusal, setRefusal ] = useState( null );
	const onWrittenRef = useRef( onWritten );
	onWrittenRef.current = onWritten;

	const read = useCommandOnce( {
		group,
		ci: COMPOSITIONS_CI,
		command: 'get',
		scope: `${ scope }:get`,
		retry: true,
		onDone: ( { result } ) => result && setAnswer( result ),
	} );
	/**
	 * The handler a write's reply runs.
	 *
	 * @param {string} verb The write.
	 * @return {import('../hooks/useCommandOnce').OnDone} Its handler.
	 */
	const written =
		( verb ) =>
		( { result, error } ) => {
			setRefusal( error );
			if ( result ) {
				setAnswer( result );
				onWrittenRef.current?.( result, verb );
			}
		};
	const saving = useCommandOnce( {
		group,
		ci: COMPOSITIONS_CI,
		command: 'save',
		scope: `${ scope }:save`,
		sendsOnRemoval: true,
		onDone: written( 'save' ),
	} );
	const restoring = useCommandOnce( {
		group,
		ci: COMPOSITIONS_CI,
		command: 'restore',
		scope: `${ scope }:restore`,
		sendsOnRemoval: true,
		onDone: written( 'restore' ),
	} );

	const { run: runRead } = read;
	const { run: runSave } = saving;
	const { run: runRestore } = restoring;

	useEffect( () => {
		runRead( formatCommandArgs( [ context ] ) );
	}, [ context, runRead ] );

	const save = useCallback(
		( markup ) => {
			setRefusal( null );
			runSave( formatCommandArgs( [ context, markup ] ) );
		},
		[ context, runSave ]
	);
	const restore = useCallback( () => {
		setRefusal( null );
		runRestore( formatCommandArgs( [ context ] ) );
	}, [ context, runRestore ] );

	return {
		answer,
		error: read.error,
		loading: null === answer && null === read.error,
		save,
		restore,
		refusal,
		writing: saving.pending || restoring.pending,
	};
}
