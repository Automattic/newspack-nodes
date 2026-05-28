/**
 * Build the canvas-background-click handler that dismisses an expanded REPL
 * transcript: returns true to "consume" the click (so SchematicCanvas skips
 * its own deselect/autofit), false if the transcript wasn't expanded — same
 * pattern in TopologyConsole and DebugOverlay. The consumer owns its
 * replExpanded state and inputRef; this just packages the dismiss recipe so
 * the two callers stay in lockstep.
 *
 * @param {Object}   args
 * @param {boolean}  args.replExpanded    Whether the transcript footer is currently expanded.
 * @param {Function} args.setReplExpanded Setter to collapse the footer.
 * @param {Object}   args.inputRef        Ref to the REPL input (to blur on dismiss).
 * @return {Function} `() => boolean` — true if the click was consumed.
 */
export function makeReplDismissHandler( {
	replExpanded,
	setReplExpanded,
	inputRef,
} ) {
	return () => {
		if ( ! replExpanded ) {
			return false;
		}
		setReplExpanded( false );
		inputRef?.current?.blur();
		return true;
	};
}
