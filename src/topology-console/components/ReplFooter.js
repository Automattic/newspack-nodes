/**
 * REPL footer — collapsible transcript + prompt + command input + status.
 *
 * Transcript surfaces worker output: command echoes (kind='sent'),
 * responses (kind='recv'), errors (kind='error'), info lines
 * (kind='info'). Expanded by default; the ▼ toggle minimizes back to
 * the bare 38px bar so the user can reclaim canvas real estate.
 * Auto-scrolls to the latest entry when growing.
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';

const STATUS_LABELS = {
	connecting: 'CONNECTING',
	open: 'CONNECTED',
	error: 'DISCONNECTED',
	closed: 'CLOSED',
};

// Transcript pane sizing. Default = 20% of the canvas area (the row
// between the WP admin bar + header above and the 38px bar below).
// Operator can drag the top edge to taste; min keeps a few lines
// visible, max fills the canvas. Persisted to localStorage so the
// preference survives reloads.
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
	topology,
	partition,
	streamStatus,
	canSend,
	onSubmit,
	onClear,
	transcript = [],
	expanded,
	onExpandedChange,
} ) {
	const [ value, setValue ] = useState( '' );
	const setExpanded = ( next ) => {
		if ( onExpandedChange ) {
			onExpandedChange(
				typeof next === 'function' ? next( expanded ) : next
			);
		}
	};
	const logRef = useRef( null );
	const inputRef = useRef( null );
	const [ height, setHeight ] = useState(
		() => loadStoredHeight() ?? defaultHeight()
	);
	const dragState = useRef( null );

	// Click anywhere in the transcript pane = refocus the input. Standard
	// terminal UX — the user expects to keep typing after glancing at
	// output. Don't steal focus when the click was on a text selection
	// (we want copy/paste to work), or when it hit one of the action
	// buttons (their own handlers do the right thing). Uses the
	// transcript element's ownerDocument so the linter's
	// no-global-get-selection rule is happy.
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

	const statusLabel =
		STATUS_LABELS[ streamStatus ] || streamStatus.toUpperCase();

	// Auto-scroll to the newest entry when the transcript grows. Only
	// runs when the panel is open; collapsed panel just shows the most
	// recent line as a peek above the input.
	useEffect( () => {
		if ( expanded && logRef.current ) {
			logRef.current.scrollTop = logRef.current.scrollHeight;
		}
	}, [ transcript, expanded ] );

	// Esc minimizes the transcript when it's open. Document-level so
	// it works whether the user is focused on the input, the canvas,
	// or anywhere else on the page. Listener only attaches while
	// expanded — no cost when minimized.
	useEffect( () => {
		if ( ! expanded ) {
			return undefined;
		}
		const handler = ( ev ) => {
			if ( ev.key === 'Escape' ) {
				ev.preventDefault();
				setExpanded( false );
			}
		};
		document.addEventListener( 'keydown', handler );
		return () => document.removeEventListener( 'keydown', handler );
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ expanded ] );

	// `/` from anywhere in the live view focuses the REPL input — same
	// shortcut convention as Discord/Slack/vim search. Skip when the
	// operator is already typing into an editable element (input,
	// textarea, contenteditable, or the REPL input itself) so the
	// literal `/` keystroke isn't stolen mid-edit. Also auto-expands
	// the transcript so the operator sees command output.
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
			// Defer so the transcript expand reflow doesn't steal focus
			// back; rAF is enough — the input is already in the DOM.
			window.requestAnimationFrame( () => inputRef.current?.focus() );
		};
		document.addEventListener( 'keydown', handler );
		return () => document.removeEventListener( 'keydown', handler );
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [] );

	// Drag-to-resize the transcript pane via the top-edge handle.
	// pageY decreases as the operator drags up → height grows; opposite
	// when dragging down. Clamped to [HEIGHT_MIN_PX, maxHeight()] so
	// the pane can't be dragged smaller than ~80px (no readable area)
	// or larger than the canvas itself.
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
				const next = Math.min(
					maxHeight(),
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
			// Suppress text selection + force the resize cursor across
			// the whole document while dragging — without these, fast
			// drags select transcript text and the cursor flickers as it
			// moves over canvas elements.
			document.body.style.userSelect = 'none';
			document.body.style.cursor = 'ns-resize';
			document.addEventListener( 'mousemove', onMove );
			document.addEventListener( 'mouseup', onUp );
		},
		[ height ]
	);

	useEffect( () => {
		try {
			window.localStorage.setItem( HEIGHT_STORAGE_KEY, String( height ) );
		} catch ( _e ) {
			// Private-mode / quota errors are non-fatal — the height
			// just won't persist across reload.
		}
	}, [ height ] );

	function handleKeyDown( ev ) {
		// Ctrl+L (or Cmd+L on macOS): clear the transcript, terminal-style.
		// The cli's readline binding does the same.
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
		if ( ev.key !== 'Enter' ) {
			return;
		}
		ev.preventDefault();
		const trimmed = value.trim();
		if ( ! trimmed ) {
			return;
		}
		// Pass the raw line up — the parent runs it through
		// shellInterpret so the same shell layer drives every code
		// path (local builtins included).
		onSubmit( trimmed );
		setValue( '' );
		setExpanded( true );
	}

	// Show the transcript pane whenever the user has explicitly
	// expanded it — even if it's empty. Initial render is minimized,
	// so an empty pane only appears after a click on ▲ or after the
	// first command auto-opens; either way the user asked for it.
	const showTranscript = expanded;

	return (
		<footer
			className={ `topology-repl${
				showTranscript ? ' is-expanded' : ''
			}` }
		>
			{ showTranscript && (
				/* The transcript is a passive display region; the click
				   handler is a UX nicety (focus the input) and doesn't
				   make this an "interactive element" in the a11y sense.
				   Keyboard users already have the input focused from the
				   start and can re-Tab to it; they don't need a key
				   binding on the transcript itself. */
				/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */
				<div
					className="topology-repl__transcript"
					ref={ logRef }
					onClick={ handleTranscriptClick }
					style={ { height: `${ height }px` } }
				>
					{ /* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */ }
					<div
						className="topology-repl__resize-handle"
						onMouseDown={ handleResizeStart }
						title="Drag to resize transcript"
						aria-label="Resize transcript"
						role="separator"
						aria-orientation="horizontal"
					/>
					<div className="topology-repl__actions">
						<button
							type="button"
							className="topology-repl__toggle"
							onClick={ () => setExpanded( false ) }
							title="Minimize transcript"
							aria-label="Minimize transcript"
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
							title="Clear and minimize transcript (Ctrl+L clears only)"
							aria-label="Clear and minimize transcript"
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
									? `${ topology }.p${ partition }> ${ entry.text }`
									: entry.text }
							</pre>
						) ) }
					</div>
				</div>
			) }
			<div className="topology-repl__bar">
				<span className="topology-repl__prompt">
					{ topology }.p{ partition }&gt;
				</span>
				<input
					ref={ inputRef }
					type="text"
					className="topology-repl__input"
					placeholder={
						canSend
							? 'ls / ls -als / make_node Echo my_node / connect_node a b …'
							: 'Connecting…'
					}
					value={ value }
					onChange={ ( ev ) => setValue( ev.target.value ) }
					onKeyDown={ handleKeyDown }
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
						title="Restore transcript"
						aria-label="Restore transcript"
					>
						▲
					</button>
				) }
			</div>
		</footer>
	);
}
