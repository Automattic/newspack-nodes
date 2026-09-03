import { useCallback } from '@wordpress/element';
import { tabulateCandidates } from '../../runtime/completion-node';
import { Core } from '../../runtime/core';
import { TO, KEY } from '../../runtime/message';
import names from '../../runtime/reserved-node-names.json';

/**
 * Wires Tab completion for both REPLs — the topology console and the debug
 * overlay's Inspector — so one path decides what a Tab asks for and how the
 * answer reaches the transcript.
 *
 * `requestCompletion( line )` queries the interpreter at `cwd`: `help` while
 * the caret is still on the first token, which answers with the verb names,
 * and `ls` afterwards, which answers with the node names. `_completion` mints
 * that query, so FROM is `_completion` and the interpreter's TO=FROM reply
 * lands back on that node for `CompletionNode.fill()` to publish — the
 * addressing is the correlation (ADR-7), and nothing here mints an id.
 * `KEY = 'completion'` names the request KIND rather than correlating it: it
 * is what makes `help` and `ls` answer with a bare newline-separated candidate
 * list instead of their tabulated human output. Stamping TO and KEY after
 * `command()` leaves the signature valid, because that signature covers the
 * command semantics — timestamp, verb, arguments, nonce — and not the
 * envelope's addressing.
 *
 * `skip` gates the request. The console passes
 * `() => toNeedsSseSession( cwd ) && ! ssePid`, so a cwd addressing an
 * attached worker stays quiet until that worker's stream is live; the
 * overlay's graph is local and leaves the never-skip default.
 *
 * `handleShowCandidates` serves the second stage of readline's protocol:
 * `ReplFooter` extends the input to the longest common prefix on the first
 * Tab and calls this on the second, which lays the candidates out as one
 * aligned transcript row.
 *
 * @param {Object}                args
 * @param {string}                args.cwd    Node path the query is addressed to.
 * @param {(message:Array)=>void} args.fill   Fills the minted message into the command interpreter (`fillCommandInterpreter` in the console, the `_command_interpreter` node's own `fill` in the overlay).
 * @param {Function}              args.append Appends one transcript entry.
 * @param {()=>boolean}           [args.skip] Predicate; true suppresses the request.
 * @return {{requestCompletion:(line:string)=>void, handleShowCandidates:(candidates:string[])=>void}} The two handlers `ReplFooter` takes as `onComplete` and `onShowCandidates`.
 */
export function useCompletion( { cwd, fill, append, skip = () => false } ) {
	// Tab-completion query, addressed to the interpreter at `cwd`.
	const requestCompletion = useCallback(
		( line ) => {
			if ( skip() ) {
				return;
			}
			// First token iff there's no whitespace before the trailing token.
			const onFirstToken = ! /\s/.test( String( line ).trimStart() );
			const verb = onFirstToken ? 'help' : 'ls';
			// Mint on `_completion` so the TO=FROM reply lands there.
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
