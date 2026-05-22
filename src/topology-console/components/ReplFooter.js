/**
 * REPL footer — collapsible transcript + prompt + command input + status.
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';

const STATUS_LABELS = {
	connecting: 'CONNECTING',
	open: 'CONNECTED',
	error: 'DISCONNECTED',
	closed: 'CLOSED',
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
	topology,
	partition,
	streamStatus,
	canSend,
	onSubmit,
	onClear,
	transcript = [],
	expanded,
	onExpandedChange,
	// Optional external ref so the parent can blur / re-focus the prompt.
	inputRef: externalInputRef,
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

	const statusLabel =
		STATUS_LABELS[ streamStatus ] || streamStatus.toUpperCase();

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
			// Suppress selection + force the resize cursor document-wide while dragging.
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
			// Private-mode/quota errors are non-fatal; height just won't persist.
		}
	}, [ height ] );

	function handleKeyDown( ev ) {
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
		if ( ev.key !== 'Enter' ) {
			return;
		}
		ev.preventDefault();
		const trimmed = value.trim();
		if ( ! trimmed ) {
			return;
		}
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
						title="Drag to resize transcript"
						aria-label="Resize transcript"
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
				</>
			) }
			<div className="topology-repl__bar">
				<span className="topology-repl__prompt">
					{ topology }.p{ partition }&gt;
				</span>
				<input
					ref={ inputRef }
					type="text"
					className="topology-repl__input"
					placeholder={ canSend ? '' : 'Connecting…' }
					value={ value }
					onChange={ ( ev ) => setValue( ev.target.value ) }
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
