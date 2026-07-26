import { useCallback } from '@wordpress/element';
import { tabulateCandidates } from '../../runtime/completion-node';
import { Core } from '../../runtime/core';
import { TO, KEY } from '../../runtime/message';
import names from '../../runtime/reserved-node-names.json';

/**
 * Shared tab-completion wiring for the debug overlay and topology console: a
 * `requestCompletion(line)` that builds the cwd-addressed `help` (first token) or
 * `ls` (later tokens) query, and a `handleShowCandidates` that tabulates the
 * candidate set into the transcript. The `skip` predicate gates the request —
 * the console passes `() => toNeedsSseSession( cwd ) && ! ssePid` so an attached-worker
 * cwd without a live stream stays quiet; the overlay leaves it at the never-skip
 * default. `fill` is the interpreter-fill fn (console: `fillCommandInterpreter`;
 * overlay: `Core.node( COMMAND_INTERPRETER )?.fill`).
 *
 * @param {Object}   args
 * @param {string}   args.cwd    Current working node path the query targets.
 * @param {Function} args.fill   Interpreter-fill fn for the minted message.
 * @param {Function} args.append Append one transcript entry.
 * @param {Function} [args.skip] Predicate; true suppresses the request.
 * @return {{ requestCompletion: Function, handleShowCandidates: Function }} The completion handlers.
 */
export function useCompletion( { cwd, fill, append, skip = () => false } ) {
	// Tab-completion query; reply routes to the silent `_completion` node.
	const requestCompletion = useCallback(
		( line ) => {
			if ( skip() ) {
				return;
			}
			// First token iff there's no whitespace before the trailing token.
			const onFirstToken = ! /\s/.test( String( line ).trimStart() );
			const verb = onFirstToken ? 'help' : 'ls';
			// The completion node mints; TO/KEY after (not signed).
			const m = Core.node( names.COMPLETION )?.command( verb, [] );
			if ( ! m ) {
				return; // unauthenticated; the next keystroke retries
			}
			m[ TO ] = cwd;
			m[ KEY ] = 'completion';
			fill( m );
		},
		[ cwd, fill, skip ]
	);

	// List completion candidates into the transcript (readline two-stage).
	const handleShowCandidates = useCallback(
		( candidates ) => {
			append( { kind: 'recv', text: tabulateCandidates( candidates ) } );
		},
		[ append ]
	);

	return { requestCompletion, handleShowCandidates };
}
