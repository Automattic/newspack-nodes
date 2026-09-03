/**
 * The REPL footer both graph surfaces mount — the topology console and the
 * debug overlay's Inspector tab. It carries the transcript pane, the prompt,
 * the command input and the connection-status pill, so one terminal serves
 * both consumers rather than each growing its own.
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { longestCommonPrefix } from '../../runtime/completion-node';
import { loadHistory, saveHistory } from '../core/consolePersistence';

/**
 * One rendered transcript line, in the shape the Dumper stamps.
 *
 * @typedef {Object} TranscriptEntry
 * @property {string} key      React list key.
 * @property {string} kind     Line style: `sent`, `recv`, `info` or `error`.
 * @property {string} text     The line itself.
 * @property {string} [prompt] Prompt a `sent` line renders ahead of its text;
 *                             absent, the current `prompt` prop stands in.
 */

/**
 * A completion reply, in the shape the CompletionNode publishes.
 *
 * @typedef {Object} CompletionReply
 * @property {number}   seq        Publication sequence. The footer acts on a
 *                                 reply once, so a re-render over an applied
 *                                 one changes nothing while a second Tab on
 *                                 an identical candidate list still lands.
 * @property {string[]} candidates Candidates the interpreter returned.
 */

/**
 * Split a command line into its trailing token and the head before it.
 *
 * Completion applies to that token alone, and the head is what the completed
 * token is joined back onto. A line ending in whitespace yields an empty
 * token, so Tab there offers every candidate rather than re-completing the
 * word already typed.
 *
 * @param {string} value The current input value.
 * @return {{head:string,token:string}} The head, its trailing whitespace kept, and the token after it.
 */
function splitTrailingToken( value ) {
	const lastSpace = value.search( /\s\S*$/ );
	if ( -1 === lastSpace ) {
		// No whitespace: the whole value is the token (head is empty).
		return { head: '', token: value };
	}
	const head = value.slice( 0, lastSpace + 1 );
	return { head, token: value.slice( lastSpace + 1 ) };
}

/** Connection-status pill label for each stream state. */
const STATUS_LABELS = {
	connecting: __( 'CONNECTING', 'newspack-nodes' ),
	open: __( 'CONNECTED', 'newspack-nodes' ),
	error: __( 'DISCONNECTED', 'newspack-nodes' ),
	closed: __( 'CLOSED', 'newspack-nodes' ),
};

/** localStorage key the operator's transcript height persists under. */
const HEIGHT_STORAGE_KEY = 'newspack-nodes:topology-console:repl-height';

/** Floor the transcript never shrinks below, in pixels. */
const HEIGHT_MIN_PX = 80;

/** Pixels one ArrowUp or ArrowDown nudges the resize handle. */
const RESIZE_STEP_PX = 20;

/**
 * Chrome the transcript can never occupy, in pixels: 32 for the WordPress
 * admin bar, 64 for the hub header, 40 for the tab bar and 38 for the prompt
 * bar. It is the pre-layout fallback alone — a consumer that has measured its
 * own panel passes `maxHeightPx`, which wins wherever it is given.
 */
const FIXED_CHROME_PX = 174;

/**
 * The height an operator who has never resized the pane opens it at: a fifth
 * of the canvas, and never under the floor.
 *
 * @return {number} Height in pixels; 200 where there is no `window`.
 */
function defaultHeight() {
	if ( typeof window === 'undefined' ) {
		return 200;
	}
	return Math.max(
		HEIGHT_MIN_PX,
		Math.round( ( window.innerHeight - FIXED_CHROME_PX ) * 0.2 )
	);
}

/**
 * Pixels held back above the transcript for the resize handle. The 6px handle
 * straddles the pane's top edge, so reserving its whole height keeps the half
 * that overhangs from clipping against the chrome above.
 */
const RESIZE_HANDLE_OVERHANG_PX = 6;

/**
 * The ceiling a drag, a nudge or a double-click may not pass when the consumer
 * measures nothing itself. Subtracting the fixed chrome and the handle keeps
 * the pane's top edge, and the handle straddling it, clear of the chrome.
 *
 * @return {number} Ceiling in pixels; 800 where there is no `window`.
 */
function maxHeight() {
	if ( typeof window === 'undefined' ) {
		return 800;
	}
	return Math.max(
		HEIGHT_MIN_PX,
		window.innerHeight - FIXED_CHROME_PX - RESIZE_HANDLE_OVERHANG_PX
	);
}

/**
 * Read the height this browser last left the transcript at.
 *
 * Reading localStorage throws in private mode and wherever site data is
 * blocked, so every failure — the throw, a missing entry, a value under the
 * floor — returns null and the caller falls back to `defaultHeight()`.
 *
 * @return {?number} The stored height in pixels, or null.
 */
function loadStoredHeight() {
	try {
		const raw = window.localStorage.getItem( HEIGHT_STORAGE_KEY );
		const n = parseInt( raw, 10 );
		return Number.isFinite( n ) && n >= HEIGHT_MIN_PX ? n : null;
	} catch ( _e ) {
		return null;
	}
}

/**
 * The REPL footer: a resizable transcript pane, the prompt, the command input,
 * and the connection-status pill. It owns the pieces a terminal is expected to
 * have — persisted command history, Tab completion, Ctrl/Cmd+L clear, `/` to
 * focus and Esc to minimize, and a transcript height that survives reloads —
 * while the parent owns the transcript itself and the expanded state.
 *
 * @param {Object}                      props
 * @param {string}                      props.prompt                  Text shown before `>`, and what an echoed line carrying no prompt of its own renders; both consumers pass the shell cwd.
 * @param {string}                      [props.streamStatus]          Stream state: `connecting`, `open`, `error`, or `closed`. Absent (the local overlay graph) reads as LIVE.
 * @param {boolean}                     props.canSend                 False disables the input and shows the connecting placeholder.
 * @param {(command:string)=>void}      props.onSubmit                Receives the trimmed command line on Enter.
 * @param {()=>void}                    [props.onClear]               Clears the transcript; bound to Ctrl/Cmd+L and the ✕ button.
 * @param {TranscriptEntry[]}           [props.transcript]            Entries to render, oldest first.
 * @param {boolean}                     props.expanded                Whether the transcript pane is open.
 * @param {(expanded:boolean)=>void}    [props.onExpandedChange]      Receives the next expanded state, an updater already resolved against the current one.
 * @param {{current:?HTMLInputElement}} [props.inputRef]              External ref to the prompt input, so the parent can blur or refocus it.
 * @param {(line:string)=>void}         [props.onComplete]            Receives the whole input line on Tab to request candidates.
 * @param {?CompletionReply}            [props.completion]            Completion reply; a fresh `seq` re-applies it.
 * @param {(matches:string[])=>void}    [props.onShowCandidates]      Receives the ambiguous matches on the second and later Tab of a run.
 * @param {?number}                     [props.maxHeightPx]           Ceiling for the transcript height; null measures against the window.
 * @param {(px:number)=>void}           [props.onOverlayHeightChange] Receives the px the transcript covers of the canvas (0 when collapsed).
 * @return {import('react').ReactElement} The footer element.
 */
export default function ReplFooter( {
	prompt,
	streamStatus,
	canSend,
	onSubmit,
	onClear,
	transcript = [],
	expanded,
	onExpandedChange,
	inputRef: externalInputRef,
	onComplete,
	completion = null,
	onShowCandidates,
	maxHeightPx = null,
	onOverlayHeightChange,
} ) {
	const [ value, setValue ] = useState( '' );
	// Command history; cursor = recalled entry, length = live draft.
	const history = useRef( loadHistory() );
	// Start past-the-end so the first ArrowUp recalls the newest command.
	const historyCursor = useRef( history.current.length );
	const historyDraft = useRef( '' );
	// The token the last Tab asked about, and the seq already applied.
	const pendingToken = useRef( null );
	const lastAppliedSeq = useRef( null );
	// Consecutive Tab-press count; readline lists ambiguous on 2nd+ press.
	const tabStreak = useRef( 0 );
	const setExpanded = useCallback(
		( next ) => {
			if ( onExpandedChange ) {
				onExpandedChange(
					typeof next === 'function' ? next( expanded ) : next
				);
			}
		},
		[ onExpandedChange, expanded ]
	);
	const logRef = useRef( null );
	const internalInputRef = useRef( null );
	const inputRef = externalInputRef ?? internalInputRef;
	const [ height, setHeight ] = useState(
		() => loadStoredHeight() ?? defaultHeight()
	);
	const dragState = useRef( null );

	// Report canvas overlap so the consumer can feed autofit a bottom inset.
	useEffect( () => {
		onOverlayHeightChange?.( expanded ? height : 0 );
	}, [ expanded, height, onOverlayHeightChange ] );

	// Click refocuses the prompt unless on a selection or interactive control.
	const handleTranscriptClick = ( ev ) => {
		const win = ev.currentTarget.ownerDocument?.defaultView;
		const selection = win?.getSelection();
		if ( selection && selection.toString().length > 0 ) {
			return;
		}
		if ( ev.target.closest( 'button, input' ) ) {
			return;
		}
		inputRef.current?.focus();
	};

	// The local overlay passes no streamStatus; its graph is always LIVE.
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
				// Blur the input so the `/` shortcut fires next keystroke.
				inputRef.current?.blur();
			}
		};
		document.addEventListener( 'keydown', handler );
		return () => document.removeEventListener( 'keydown', handler );
	}, [ expanded, setExpanded, inputRef ] );

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
	}, [ setExpanded, inputRef ] );

	// Dbl-click resize handle toggles between max ceiling and default height.
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

	// Drag the top edge to resize, clamped to the floor and the ceiling.
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
			// Suppress selection + force ns-resize cursor while dragging.
			document.body.style.userSelect = 'none';
			document.body.style.cursor = 'ns-resize';
			document.addEventListener( 'mousemove', onMove );
			document.addEventListener( 'mouseup', onUp );
		},
		[ height, maxHeightPx ]
	);

	// Keyboard resize: Arrow keys nudge by RESIZE_STEP_PX, clamped like drag.
	const handleResizeKeyDown = useCallback(
		( ev ) => {
			if ( ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown' ) {
				return;
			}
			ev.preventDefault();
			const ceiling = maxHeightPx ?? maxHeight();
			const delta =
				ev.key === 'ArrowUp' ? RESIZE_STEP_PX : -RESIZE_STEP_PX;
			setHeight( ( h ) =>
				Math.min(
					Math.max( HEIGHT_MIN_PX, ceiling ),
					Math.max( HEIGHT_MIN_PX, h + delta )
				)
			);
		},
		[ maxHeightPx ]
	);

	// Clamp existing height down if ceiling shrinks (panel resized smaller).
	useEffect( () => {
		if ( maxHeightPx !== null && height > maxHeightPx ) {
			setHeight( Math.max( HEIGHT_MIN_PX, maxHeightPx ) );
		}
	}, [ maxHeightPx, height ] );

	// Re-clamp on WINDOW resize too, else height outgrows the shrunk ceiling.
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
			// Private-mode/quota errors are non-fatal; height won't persist.
		}
	}, [ height ] );

	// Apply a completion reply: extend the input to the LCP, else list options.
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
		// Unique match: complete token + append a space (readline behavior).
		if ( 1 === matches.length ) {
			setValue( head + matches[ 0 ] + ' ' );
			return;
		}
		const lcp = longestCommonPrefix( matches );
		if ( lcp.length > token.length ) {
			setValue( head + lcp );
			return;
		}
		// LCP can't extend (ambiguous); readline lists only on 2nd+ Tab of run.
		if ( tabStreak.current >= 2 && onShowCandidates ) {
			onShowCandidates( matches );
		}
	}, [ completion, value, onShowCandidates ] );

	function handleKeyDown( ev ) {
		// Any non-Tab key (modifiers aside) breaks a Tab run.
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
		// Tab requests completion for the trailing token; reply via prop.
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
		// Record in history, collapsing an immediate duplicate of last entry.
		const entries = history.current;
		if ( entries[ entries.length - 1 ] !== trimmed ) {
			entries.push( trimmed );
			saveHistory( entries ); // persist recall across reloads [87].
		}
		// Reset the cursor past-the-end and drop the stashed draft.
		historyCursor.current = entries.length;
		historyDraft.current = '';
		// Hand the trimmed line up; the parent runs it through the Shell.
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
					<div
						className="topology-repl__resize-handle"
						onMouseDown={ handleResizeStart }
						onDoubleClick={ handleResizeDoubleClick }
						onKeyDown={ handleResizeKeyDown }
						tabIndex={ 0 }
						title={ __(
							'Drag to resize transcript',
							'newspack-nodes'
						) }
						aria-label={ __(
							'Resize transcript',
							'newspack-nodes'
						) }
						// An arrow-key splitter is a one-axis vertical slider.
						role="slider"
						aria-orientation="vertical"
						aria-valuemin={ HEIGHT_MIN_PX }
						aria-valuemax={ Math.max(
							HEIGHT_MIN_PX,
							maxHeightPx ?? maxHeight()
						) }
						aria-valuenow={ height }
						// Sibling of the transcript, anchored to its top edge.
						style={ { bottom: `${ height + 38 - 3 }px` } }
					/>
					<div
						className="topology-repl__transcript"
						ref={ logRef }
						onClick={ handleTranscriptClick }
						role="presentation"
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
					// Focus opens the transcript; Esc and the buttons close it.
					onFocus={ () => setExpanded( true ) }
					disabled={ ! canSend }
					autoComplete="off"
					spellCheck="false"
				/>
				<span className="newspack-nodes-status topology-repl__status">
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
