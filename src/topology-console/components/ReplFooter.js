/**
 * REPL footer — collapsible transcript + prompt + command input + status.
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { longestCommonPrefix } from '../../runtime/completion';

// The whitespace-delimited token under the cursor — the last token of the
// input, or '' after a trailing space. Returns the token + the prefix before it.
function splitTrailingToken( value ) {
	const lastSpace = value.search( /\s\S*$/ );
	if ( -1 === lastSpace ) {
		// No whitespace: the whole value is the token (head is empty).
		return { head: '', token: value };
	}
	const head = value.slice( 0, lastSpace + 1 );
	return { head, token: value.slice( lastSpace + 1 ) };
}

const STATUS_LABELS = {
	connecting: __( 'CONNECTING', 'newspack-nodes' ),
	open: __( 'CONNECTED', 'newspack-nodes' ),
	error: __( 'DISCONNECTED', 'newspack-nodes' ),
	closed: __( 'CLOSED', 'newspack-nodes' ),
};

// Transcript pane sizing; default 20% of canvas, drag-resizable, persisted.
const HEIGHT_STORAGE_KEY = 'newspack-nodes:topology-console:repl-height';
const HEIGHT_MIN_PX = 80;
const FIXED_CHROME_PX = 134; // 32 (WP admin bar) + 64 (header) + 38 (bar)
function defaultHeight() {
	if ( typeof window === 'undefined' ) {
		return 200;
	}
	return Math.max(
		HEIGHT_MIN_PX,
		Math.round( ( window.innerHeight - FIXED_CHROME_PX ) * 0.2 )
	);
}
function maxHeight() {
	if ( typeof window === 'undefined' ) {
		return 800;
	}
	return Math.max( HEIGHT_MIN_PX, window.innerHeight - FIXED_CHROME_PX );
}
function loadStoredHeight() {
	try {
		const raw = window.localStorage.getItem( HEIGHT_STORAGE_KEY );
		const n = parseInt( raw, 10 );
		return Number.isFinite( n ) && n >= HEIGHT_MIN_PX ? n : null;
	} catch ( _e ) {
		return null;
	}
}

export default function ReplFooter( {
	prompt,
	streamStatus,
	canSend,
	onSubmit,
	onClear,
	transcript = [],
	expanded,
	onExpandedChange,
	// Optional external ref so the parent can blur / re-focus the prompt.
	inputRef: externalInputRef,
	// Tab-completion: `onComplete(line)` fires the completion query; the reply
	// arrives back as the `completion` prop ( { candidates, seq } ); when ≥2
	// matches share no extending prefix, `onShowCandidates(list)` lists them.
	onComplete,
	completion = null,
	onShowCandidates,
	// Optional ceiling override — when set, takes precedence over the
	// viewport-based maxHeight(). The debug overlay passes its panel's
	// inner height minus header height so the transcript can't grow past
	// the overlay's bounds (default maxHeight assumes a full-page console).
	maxHeightPx = null,
} ) {
	const [ value, setValue ] = useState( '' );
	// Command history (oldest→newest). `historyCursor` points at the recalled
	// entry; `history.length` means "past the end" (the live draft). The draft
	// typed before navigation began is stashed so Down can restore it.
	const history = useRef( [] );
	const historyCursor = useRef( 0 );
	const historyDraft = useRef( '' );
	// The token being completed when the last Tab fired, plus the last applied
	// completion seq so a re-render doesn't re-apply the same reply. Cleared once
	// a reply is consumed.
	const pendingToken = useRef( null );
	const lastAppliedSeq = useRef( null );
	// Count of consecutive Tab presses (reset by any other key / typing).
	// readline lists ambiguous candidates only when the previous command was
	// also a Tab — i.e. on the 2nd+ press of a run — whether or not the first
	// press extended the token.
	const tabStreak = useRef( 0 );
	const setExpanded = ( next ) => {
		if ( onExpandedChange ) {
			onExpandedChange(
				typeof next === 'function' ? next( expanded ) : next
			);
		}
	};
	const logRef = useRef( null );
	const internalInputRef = useRef( null );
	const inputRef = externalInputRef ?? internalInputRef;
	const [ height, setHeight ] = useState(
		() => loadStoredHeight() ?? defaultHeight()
	);
	const dragState = useRef( null );

	// Click in the transcript refocuses the input, unless on a selection
	// or a button (preserves copy/paste; via ownerDocument for the linter).
	const handleTranscriptClick = ( ev ) => {
		const win = ev.currentTarget.ownerDocument?.defaultView;
		const selection = win?.getSelection();
		if ( selection && selection.toString().length > 0 ) {
			return;
		}
		if ( ev.target.closest( 'button' ) ) {
			return;
		}
		inputRef.current?.focus();
	};

	// `streamStatus` is undefined for local-only callers (the debug overlay reads
	// Core synchronously — no stream). Treat absent as LIVE so the LED reads as
	// connected without exploding on the missing `.toUpperCase()`.
	const statusLabel = streamStatus
		? STATUS_LABELS[ streamStatus ] || streamStatus.toUpperCase()
		: __( 'LIVE', 'newspack-nodes' );

	// Auto-scroll to the newest entry when the open transcript grows.
	useEffect( () => {
		if ( expanded && logRef.current ) {
			logRef.current.scrollTop = logRef.current.scrollHeight;
		}
	}, [ transcript, expanded ] );

	// Esc minimizes the open transcript (document-level).
	useEffect( () => {
		if ( ! expanded ) {
			return undefined;
		}
		const handler = ( ev ) => {
			if ( ev.key === 'Escape' ) {
				ev.preventDefault();
				setExpanded( false );
				// Blur the input so the `/` shortcut below fires next keystroke.
				inputRef.current?.blur();
			}
		};
		document.addEventListener( 'keydown', handler );
		return () => document.removeEventListener( 'keydown', handler );
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ expanded ] );

	// `/` focuses the REPL input (skipped while typing in an editable element).
	useEffect( () => {
		const handler = ( ev ) => {
			if ( ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey ) {
				return;
			}
			const t = ev.target;
			if (
				t &&
				( t.tagName === 'INPUT' ||
					t.tagName === 'TEXTAREA' ||
					t.isContentEditable )
			) {
				return;
			}
			ev.preventDefault();
			setExpanded( true );
			// Defer past the expand reflow so it doesn't steal focus back.
			window.requestAnimationFrame( () => inputRef.current?.focus() );
		};
		document.addEventListener( 'keydown', handler );
		return () => document.removeEventListener( 'keydown', handler );
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [] );

	// Double-click the resize handle toggles the transcript between its
	// max ceiling (visually like dragging it to the top) and the default
	// starting height. A small ref tracks whether the LAST toggle maximized
	// so the next dbl-click goes the other way.
	const lastWasMaxRef = useRef( false );
	const handleResizeDoubleClick = useCallback( () => {
		const ceiling = maxHeightPx ?? maxHeight();
		if ( lastWasMaxRef.current ) {
			setHeight( defaultHeight() );
			lastWasMaxRef.current = false;
		} else {
			setHeight( Math.max( HEIGHT_MIN_PX, ceiling ) );
			lastWasMaxRef.current = true;
		}
	}, [ maxHeightPx ] );

	// Drag the top edge to resize, clamped to [HEIGHT_MIN_PX, maxHeight()].
	const handleResizeStart = useCallback(
		( ev ) => {
			ev.preventDefault();
			dragState.current = {
				startY: ev.clientY,
				startHeight: height,
			};
			const onMove = ( e ) => {
				if ( ! dragState.current ) {
					return;
				}
				const dy = dragState.current.startY - e.clientY;
				const ceiling = maxHeightPx ?? maxHeight();
				const next = Math.min(
					ceiling,
					Math.max(
						HEIGHT_MIN_PX,
						dragState.current.startHeight + dy
					)
				);
				setHeight( next );
			};
			const onUp = () => {
				dragState.current = null;
				document.removeEventListener( 'mousemove', onMove );
				document.removeEventListener( 'mouseup', onUp );
				document.body.style.userSelect = '';
				document.body.style.cursor = '';
			};
			// Suppress selection + force the resize cursor document-wide while dragging.
			document.body.style.userSelect = 'none';
			document.body.style.cursor = 'ns-resize';
			document.addEventListener( 'mousemove', onMove );
			document.addEventListener( 'mouseup', onUp );
		},
		[ height, maxHeightPx ]
	);

	// Clamp existing height down if the ceiling shrinks (panel resized smaller).
	useEffect( () => {
		if ( maxHeightPx !== null && height > maxHeightPx ) {
			setHeight( Math.max( HEIGHT_MIN_PX, maxHeightPx ) );
		}
	}, [ maxHeightPx, height ] );

	// Re-clamp when the WINDOW shrinks too — without an explicit ceiling, the
	// console's viewport-based maxHeight() would drop but `height` wouldn't,
	// leaving the transcript overflowing past the top of the page and burying
	// its drag handle out of reach. Listen for resize and clamp on the fly.
	useEffect( () => {
		const onResize = () => {
			const ceiling = maxHeightPx ?? maxHeight();
			setHeight( ( h ) =>
				Math.min( h, Math.max( HEIGHT_MIN_PX, ceiling ) )
			);
		};
		window.addEventListener( 'resize', onResize );
		return () => window.removeEventListener( 'resize', onResize );
	}, [ maxHeightPx ] );

	useEffect( () => {
		try {
			window.localStorage.setItem( HEIGHT_STORAGE_KEY, String( height ) );
		} catch ( _e ) {
			// Private-mode/quota errors are non-fatal; height just won't persist.
		}
	}, [ height ] );

	// Apply a completion reply (readline two-stage): filter candidates to the
	// remembered token, compute the LCP; extend the input to the LCP if it grows
	// the token, else list the options. Guarded against stale replies (the input
	// must still end with the token that fired the query) and re-renders (seq).
	useEffect( () => {
		if ( ! completion || pendingToken.current === null ) {
			return;
		}
		if ( completion.seq === lastAppliedSeq.current ) {
			return;
		}
		lastAppliedSeq.current = completion.seq;
		const token = pendingToken.current;
		pendingToken.current = null;
		// Stale guard: the input must still end with the token we asked about.
		const { head, token: liveToken } = splitTrailingToken( value );
		if ( liveToken !== token ) {
			return;
		}
		const matches = ( completion.candidates || [] ).filter( ( c ) =>
			c.startsWith( token )
		);
		if ( 0 === matches.length ) {
			return;
		}
		// Unique match: complete the token and append a space (readline behavior),
		// even when the token already equals the candidate.
		if ( 1 === matches.length ) {
			setValue( head + matches[ 0 ] + ' ' );
			return;
		}
		const lcp = longestCommonPrefix( matches );
		if ( lcp.length > token.length ) {
			setValue( head + lcp );
			return;
		}
		// LCP can't extend the token (ambiguous). readline lists candidates only
		// on the 2nd+ Tab of a consecutive run — the first press just bells.
		if ( tabStreak.current >= 2 && onShowCandidates ) {
			onShowCandidates( matches );
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ completion ] );

	function handleKeyDown( ev ) {
		// Any key other than Tab (modifiers excepted) breaks a Tab run, so the
		// next Tab starts a fresh single press.
		if (
			ev.key !== 'Tab' &&
			! [ 'Shift', 'Control', 'Alt', 'Meta' ].includes( ev.key )
		) {
			tabStreak.current = 0;
		}
		// Ctrl/Cmd+L clears the transcript, terminal-style.
		if (
			( ev.ctrlKey || ev.metaKey ) &&
			( ev.key === 'l' || ev.key === 'L' )
		) {
			ev.preventDefault();
			if ( onClear ) {
				onClear();
			}
			return;
		}
		// Tab requests completion for the trailing token; the reply lands via the
		// `completion` prop and the effect above applies the LCP.
		if ( ev.key === 'Tab' && ev.target === inputRef.current ) {
			ev.preventDefault();
			if ( ! onComplete ) {
				return;
			}
			tabStreak.current += 1;
			const { token } = splitTrailingToken( value );
			pendingToken.current = token;
			onComplete( value );
			return;
		}
		// Up/Down recall history, but only from the prompt input itself.
		if (
			( ev.key === 'ArrowUp' || ev.key === 'ArrowDown' ) &&
			ev.target === inputRef.current
		) {
			const entries = history.current;
			if ( ev.key === 'ArrowUp' ) {
				if ( historyCursor.current >= entries.length ) {
					// Entering history: stash the in-progress draft.
					historyDraft.current = value;
				}
				if ( historyCursor.current > 0 ) {
					ev.preventDefault();
					historyCursor.current -= 1;
					setValue( entries[ historyCursor.current ] );
				} else if ( entries.length > 0 ) {
					// Already at oldest — clamp without moving.
					ev.preventDefault();
				}
				return;
			}
			// ArrowDown: walk toward newer; past the end restores the draft.
			if ( historyCursor.current < entries.length ) {
				ev.preventDefault();
				historyCursor.current += 1;
				setValue(
					historyCursor.current >= entries.length
						? historyDraft.current
						: entries[ historyCursor.current ]
				);
			}
			return;
		}
		if ( ev.key !== 'Enter' ) {
			return;
		}
		ev.preventDefault();
		const trimmed = value.trim();
		if ( ! trimmed ) {
			return;
		}
		// Record in history, collapsing an immediate duplicate of the last entry.
		const entries = history.current;
		if ( entries[ entries.length - 1 ] !== trimmed ) {
			entries.push( trimmed );
		}
		// Reset the cursor past-the-end and drop the stashed draft.
		historyCursor.current = entries.length;
		historyDraft.current = '';
		// Pass the raw line up; the parent runs it through shell.
		onSubmit( trimmed );
		setValue( '' );
		setExpanded( true );
	}

	const showTranscript = expanded;

	return (
		<footer
			className={ `topology-repl${
				showTranscript ? ' is-expanded' : ''
			}` }
		>
			{ showTranscript && (
				<>
					{ /* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */ }
					<div
						className="topology-repl__resize-handle"
						onMouseDown={ handleResizeStart }
						onDoubleClick={ handleResizeDoubleClick }
						title={ __(
							'Drag to resize transcript',
							'newspack-nodes'
						) }
						aria-label={ __(
							'Resize transcript',
							'newspack-nodes'
						) }
						role="separator"
						aria-orientation="horizontal"
						// Sibling of the transcript so it stays anchored to the top edge.
						style={ { bottom: `${ height + 38 - 3 }px` } }
					/>
					{ /* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */ }
					<div
						className="topology-repl__transcript"
						ref={ logRef }
						onClick={ handleTranscriptClick }
						style={ { height: `${ height }px` } }
					>
						<div className="topology-repl__actions">
							<button
								type="button"
								className="topology-repl__toggle"
								onClick={ () => setExpanded( false ) }
								title={ __(
									'Minimize transcript',
									'newspack-nodes'
								) }
								aria-label={ __(
									'Minimize transcript',
									'newspack-nodes'
								) }
							>
								▼
							</button>
							<button
								type="button"
								className="topology-repl__clear"
								onClick={ () => {
									if ( onClear ) {
										onClear();
									}
									setExpanded( false );
								} }
								title={ __(
									'Clear and minimize transcript (Ctrl+L clears only)',
									'newspack-nodes'
								) }
								aria-label={ __(
									'Clear and minimize transcript',
									'newspack-nodes'
								) }
							>
								✕
							</button>
						</div>
						<div className="topology-repl__entries">
							{ transcript.map( ( entry ) => (
								<pre
									key={ entry.key }
									className={ `topology-repl__entry topology-repl__entry--${ entry.kind }` }
								>
									{ entry.kind === 'sent'
										? `${ entry.prompt ?? prompt }> ${
												entry.text
										  }`
										: entry.text }
								</pre>
							) ) }
						</div>
					</div>
				</>
			) }
			<div className="topology-repl__bar">
				<span className="topology-repl__prompt">{ prompt }&gt;</span>
				<input
					ref={ inputRef }
					type="text"
					className="topology-repl__input"
					placeholder={
						canSend ? '' : __( 'Connecting…', 'newspack-nodes' )
					}
					value={ value }
					onChange={ ( ev ) => {
						tabStreak.current = 0;
						setValue( ev.target.value );
					} }
					onKeyDown={ handleKeyDown }
					// Focus → show transcript; blur→hide is handled elsewhere
					// (onBlur here would fire on node/Inspector clicks too).
					onFocus={ () => setExpanded( true ) }
					disabled={ ! canSend }
					autoComplete="off"
					spellCheck="false"
				/>
				<span className="topology-repl__status">
					<span
						className={ `topology-repl__dot${
							streamStatus === 'open' ? ' is-pulsing' : ''
						}` }
					/>
					{ statusLabel }
				</span>
				{ ! expanded && (
					<button
						type="button"
						className="topology-repl__toggle"
						onClick={ () => setExpanded( true ) }
						title={ __( 'Restore transcript', 'newspack-nodes' ) }
						aria-label={ __(
							'Restore transcript',
							'newspack-nodes'
						) }
					>
						▲
					</button>
				) }
			</div>
		</footer>
	);
}
