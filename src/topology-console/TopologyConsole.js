/**
 * TopologyConsole — top-level shell.
 *
 * Wires:
 *   useTopologyStream → SSE subscription
 *   parseLsOutput     → derive {nodes, edges} from msg payloads
 *   Header            → topology/partition selectors + LIVE LED
 *   Palette           → static class catalog (inert in v1)
 *   CanvasFrame       → plotter chrome (meta + reticles + title block)
 *   SchematicCanvas   → SVG node graph
 *   Inspector         → selected-node detail pane
 *   ReplFooter        → prompt + status line
 */

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from '@wordpress/element';
import apiFetch from '@wordpress/api-fetch';

import CanvasFrame from './components/CanvasFrame';
import Header from './components/Header';
import Inspector from './components/Inspector';
import { ConfirmModal } from './components/Modal';
import Palette from './components/Palette';
import ReplFooter from './components/ReplFooter';
import SchematicCanvas from './components/SchematicCanvas';

import { useClassCatalog } from './hooks/useClassCatalog';
import { useTopologyStream } from './hooks/useTopologyStream';
import { addNode, generateNodeName } from './utils/draftGraph';
import { parseMetadata } from './utils/parseMetadata';
import { shellInterpret, SHELL_BUILTINS_BLURB } from './utils/shellInterpret';

// The topology dropdown and partition counts both come from the same map
// injected by the admin page as `NewspackNodesData.topologyPartitions`,
// itself the resolved `newspack_nodes/topologies` filter that the
// supervisor uses to spawn workers. Reading from one source keeps the
// console in lockstep with whatever fleets are actually running, with no
// drift when topology names change (e.g. `firehose-workers` →
// `firehose-workers-and-jobs`).
function topologyMap() {
	return (
		( window.NewspackNodesData &&
			window.NewspackNodesData.topologyPartitions ) ||
		{}
	);
}

const TOPOLOGIES = Object.keys( topologyMap() );

function partitionList( topology ) {
	const n = topologyMap()[ topology ] || 1;
	return Array.from( { length: n }, ( _, i ) => i );
}

const TRANSCRIPT_MAX = 200;

// Per-node rate history depth. With STATS_INTERVAL_S = 1s on the
// controller side, 60 samples = ~1 minute of trailing data, plenty
// for a quick "is this node busy or quiet?" glance.
const RATE_HISTORY_MAX = 60;

// Message TYPE bitmask flags, mirroring substrate's class-message.php
// constants so we can apply Dumper-style type-aware rendering to each
// incoming SSE msg envelope.
const TM_BYTESTREAM = 1;
const TM_EOF = 2;
const TM_PING = 4;
const TM_COMMAND = 8;
const TM_RESPONSE = 16;
const TM_ERROR = 32;
const TM_INFO = 64;
const TM_STRUCT = 256;

// eslint-disable-next-line no-bitwise
const has = ( type, flag ) => ( type & flag ) !== 0;

// Render TM_FLAGS as a pipe-joined uppercase label string, matching
// the substrate Dumper's debug header. `TM_COMMAND|TM_RESPONSE`,
// `TM_INFO`, etc. Empty type renders as `0`.
const TM_LABELS = [
	[ TM_BYTESTREAM, 'TM_BYTESTREAM' ],
	[ TM_EOF, 'TM_EOF' ],
	[ TM_PING, 'TM_PING' ],
	[ TM_COMMAND, 'TM_COMMAND' ],
	[ TM_RESPONSE, 'TM_RESPONSE' ],
	[ TM_ERROR, 'TM_ERROR' ],
	[ TM_INFO, 'TM_INFO' ],
	[ TM_STRUCT, 'TM_STRUCT' ],
];
function formatTypeLabel( type ) {
	const flags = TM_LABELS.filter( ( [ flag ] ) => has( type, flag ) ).map(
		( [ , label ] ) => label
	);
	return flags.length
		? flags.join( ' | ' )
		: `TM_UNKNOWN(0x${ type.toString( 16 ) })`;
}

// Stringify VALUE for the debug header — objects get one-line JSON,
// strings pass through, everything else gets String()'d.
function stringifyValue( value ) {
	if ( typeof value === 'string' ) {
		return value;
	}
	if ( value === null || value === undefined ) {
		return '';
	}
	try {
		return JSON.stringify( value, null, 2 );
	} catch ( _e ) {
		return String( value );
	}
}

// `debug_level 1` header — single line summarizing the message:
// `<TM_FLAGS> from <FROM>:` — NO value on the header line, the
// curated render that follows produces the payload. Matches the
// substrate Dumper's `$flags . ' from ' . $from . ':'` exactly.
function buildDebugHeader1( msg ) {
	const label = formatTypeLabel(
		typeof msg.type === 'number' ? msg.type : 0
	);
	const from = msg.from || '';
	return `${ label } from ${ from }:`;
}

// `debug_level 2` header — full envelope as a structural multi-line
// render. Mirrors the substrate Dumper's `format_envelope_dump`.
function buildDebugHeader2( msg ) {
	const label = formatTypeLabel(
		typeof msg.type === 'number' ? msg.type : 0
	);
	const ts = msg.ts ?? '';
	const tsHuman =
		typeof ts === 'number' && Number.isFinite( ts )
			? ` (${ new Date( ts * 1000 )
					.toISOString()
					.replace( 'T', ' ' )
					.replace( /\.\d+Z$/, ' UTC' ) })`
			: '';
	const value = stringifyValue( msg.value );
	const indentedValue = value
		.split( '\n' )
		.map( ( line, i ) => ( i === 0 ? line : '               ' + line ) )
		.join( '\n' );
	return [
		'Message {',
		'    type:      ' + label,
		'    from:      ' + ( msg.from ?? '' ),
		'    to:        ' + ( msg.to ?? '' ),
		'    id:        ' + ( msg.id ?? '' ),
		'    key:       ' + ( msg.key ?? '' ),
		'    timestamp: ' + ts + tsHuman,
		'    value:     ' + indentedValue,
		'}',
	].join( '\n' );
}

/**
 * Convert a raw SSE msg envelope into a transcript entry, following the
 * cli Dumper's render rules so the GUI surfaces what the terminal would:
 *
 *   - TM_EOF                       → dropped (control marker, no output)
 *   - TM_COMMAND|TM_RESPONSE       → payload only, never the wrapper JSON
 *   - TM_COMMAND|TM_ERROR          → unwrapped payload, error styling
 *   - TM_ERROR                     → value as-is, error styling
 *   - TM_PING                      → "round trip time: X ms"
 *   - TM_STRUCT                    → JSON-encoded value
 *   - TM_INFO                      → value as-is (no prefix; debug_level 1
 *                                    adds the `TM_INFO from <from>:` header
 *                                    when verbosity is wanted)
 *   - default (TM_BYTESTREAM)      → value as-is
 *
 * Returns null when the message should be dropped silently.
 *
 * @param {Object} msg Raw SSE msg envelope (type, from, to, value, ...).
 * @return {Object|null} { kind, text } transcript entry or null to drop.
 */
function dumperRender( msg ) {
	const type = typeof msg.type === 'number' ? msg.type : 0;
	const value = msg.value;
	if ( has( type, TM_EOF ) ) {
		return null;
	}
	const unwrapPayload = () => {
		if ( value && typeof value === 'object' ) {
			return typeof value.payload === 'string' ? value.payload : '';
		}
		return typeof value === 'string' ? value : '';
	};
	if ( has( type, TM_COMMAND ) && has( type, TM_RESPONSE ) ) {
		const payload = unwrapPayload();
		if ( ! payload ) {
			return null;
		}
		return { kind: 'recv', text: payload };
	}
	if ( has( type, TM_COMMAND ) && has( type, TM_ERROR ) ) {
		return { kind: 'error', text: unwrapPayload() };
	}
	if ( has( type, TM_ERROR ) ) {
		return { kind: 'error', text: String( value ?? '' ) };
	}
	if ( has( type, TM_PING ) ) {
		const sent = parseFloat( value );
		const now = Date.now() / 1000;
		const rtt = ( ( now - sent ) * 1000 ).toFixed( 2 );
		return { kind: 'info', text: `round trip time: ${ rtt } ms` };
	}
	if ( has( type, TM_STRUCT ) ) {
		return {
			kind: 'recv',
			text:
				typeof value === 'string'
					? value
					: JSON.stringify( value, null, 2 ),
		};
	}
	// TM_INFO and default TM_BYTESTREAM both render as plain
	// payload — the substrate Dumper does the same. `debug_level 1`
	// adds the `TM_INFO from <from>:` header for verbosity; the
	// curated level-0 render shows the payload only.
	if ( has( type, TM_INFO ) || has( type, TM_BYTESTREAM ) ) {
		return { kind: 'recv', text: String( value ?? '' ) };
	}
	return null;
}

export default function TopologyConsole() {
	const [ topology, setTopology ] = useState( TOPOLOGIES[ 0 ] );
	const [ partition, setPartition ] = useState( 0 );
	const [ selectedId, setSelectedId ] = useState( null );
	// Hover state — lifted so the Inspector can highlight a node by
	// hovering one of its routing-list links (target/also/from).
	const [ hoveredId, setHoveredId ] = useState( null );
	const [ parsed, setParsed ] = useState( { nodes: [], edges: [] } );
	// Edit-mode state. `view` (default) renders the live SSE-driven graph;
	// `edit` freezes a draft snapshot taken at the toggle moment so SSE
	// pushes never clobber operator work in progress. `baseline` is the
	// draft as it stood at edit-mode entry — kept separate so the dirty
	// check compares draft-vs-baseline (real edits) rather than
	// draft-vs-live-parsed (which would constantly disagree with itself
	// thanks to SSE counter updates).
	const [ mode, setMode ] = useState( 'view' );
	const [ draft, setDraft ] = useState( { nodes: [], edges: [] } );
	const [ baseline, setBaseline ] = useState( { nodes: [], edges: [] } );
	// Pending discard-confirm modal. Null = no modal. Holds the closure
	// to invoke if the user clicks "Discard" — keeps the confirm logic
	// declarative (state-driven), not imperative window.confirm-style.
	const [ discardModal, setDiscardModal ] = useState( null );
	// Lazy-load the class catalog the first time the user enters edit
	// mode. useClassCatalog caches the response, so re-entries are free.
	const catalog = useClassCatalog( { enabled: mode === 'edit' } );
	const [ transcript, setTranscript ] = useState( [] );
	// Lifted: ReplFooter's transcript visibility, so Inspector actions
	// (Dump, Tail) can pop the pane open when they fire commands the
	// user wants to see the response of.
	const [ replExpanded, setReplExpanded ] = useState( false );

	// Per-node rate tracking: { id: { count, ts, rate, lastChangedTs } }
	// Updated each time a `gui:auto` ls table arrives. rate = Δcount/Δs
	// across consecutive ticks; lastChangedTs marks the last tick where
	// count grew so the Inspector can render "Xs ago" without polling.
	const rateRef = useRef( new Map() );
	const [ rateVersion, setRateVersion ] = useState( 0 );

	// Worker uptime, refreshed by `gui:uptime` polls every UPTIME_INTERVAL_S
	// (5s). Substrate's `uptime` verb returns one line like
	// `HH:MM:SS  up N days, HH:MM:SS\n` — we keep just the days/HMS half for
	// the Inspector's Process section.
	const [ uptime, setUptime ] = useState( null );

	// Local Dumper verbosity dial. 0 = curated render only (default);
	// 1 = prepend a one-line `<TM_FLAGS> from <from>: <value>` header
	// to every incoming msg; 2 = same as 1 but full envelope on the
	// header line and the value on the next line. Mirrors the substrate
	// Dumper's `debug_level` semantics. Held in a ref (not state) so
	// reads happen synchronously inside handleMessage without re-binding
	// the SSE callback every time the level changes.
	const debugLevelRef = useRef( 0 );

	// User-pinned positions, keyed by node name. Survives reloads via
	// localStorage; scoped per `topology.partition` so positions don't
	// bleed between worker types. Loaded on topology/partition change;
	// updates write back synchronously on each drag commit.
	const positionStorageKey = `newspack-nodes:topology:${ topology }.p${ partition }:positions`;
	const [ positionOverrides, setPositionOverrides ] = useState( {} );
	useEffect( () => {
		try {
			const raw = window.localStorage.getItem( positionStorageKey );
			setPositionOverrides( raw ? JSON.parse( raw ) : {} );
		} catch ( _err ) {
			setPositionOverrides( {} );
		}
	}, [ positionStorageKey ] );
	const handlePositionChange = useCallback(
		( nodeId, pos ) => {
			setPositionOverrides( ( prev ) => {
				const next = { ...prev, [ nodeId ]: pos };
				try {
					window.localStorage.setItem(
						positionStorageKey,
						JSON.stringify( next )
					);
				} catch ( _err ) {
					// localStorage may be disabled / quota'd; silently
					// fall back to in-session-only overrides.
				}
				return next;
			} );
		},
		[ positionStorageKey ]
	);
	// Pan/zoom viewport — same persistence shape as positionOverrides
	// so reloads / topology switches preserve the user's last view.
	// Null means "no override" → SchematicCanvas autofits to the
	// tight bbox. Writes debounce via a 200ms timeout so a pan-drag's
	// 60 setState/sec doesn't hammer localStorage.
	const viewportStorageKey = `newspack-nodes:topology:${ topology }.p${ partition }:viewport`;
	const [ viewport, setViewport ] = useState( null );
	useEffect( () => {
		try {
			const raw = window.localStorage.getItem( viewportStorageKey );
			setViewport( raw ? JSON.parse( raw ) : null );
		} catch ( _err ) {
			setViewport( null );
		}
	}, [ viewportStorageKey ] );
	const viewportSaveTimerRef = useRef( null );
	const handleViewportChange = useCallback(
		( next ) => {
			setViewport( next );
			if ( viewportSaveTimerRef.current ) {
				clearTimeout( viewportSaveTimerRef.current );
			}
			viewportSaveTimerRef.current = setTimeout( () => {
				try {
					if ( next === null ) {
						window.localStorage.removeItem( viewportStorageKey );
					} else {
						window.localStorage.setItem(
							viewportStorageKey,
							JSON.stringify( next )
						);
					}
				} catch ( _err ) {
					// localStorage quota'd / disabled; in-memory only.
				}
			}, 200 );
		},
		[ viewportStorageKey ]
	);

	// Reset Layout also clears any pan/zoom override and signals the
	// canvas to autofit to the (refreshed) tight bbox via a `null`
	// viewport — SchematicCanvas treats null as "autofit on next
	// render." Deferred by one tick so the cleared positions have
	// time to flow through before the autofit recomputes the bbox.
	const handleResetLayout = useCallback( () => {
		setPositionOverrides( {} );
		try {
			window.localStorage.removeItem( positionStorageKey );
		} catch ( _err ) {
			// Ignore — clearing in-memory state is the important part.
		}
		setTimeout( () => {
			setViewport( null );
			try {
				window.localStorage.removeItem( viewportStorageKey );
			} catch ( _err ) {
				// Ignore.
			}
		}, 0 );
	}, [ positionStorageKey, viewportStorageKey ] );
	const hasOverrides = Object.keys( positionOverrides ).length > 0;

	const partitions = useMemo( () => partitionList( topology ), [ topology ] );

	// If the user switches to a topology with fewer partitions than the
	// one they were on, reset the partition selector to p0 so we don't
	// stream from a non-existent worker.
	useEffect( () => {
		if ( partition >= partitions.length ) {
			setPartition( 0 );
		}
	}, [ partitions, partition ] );

	const appendTranscript = useCallback( ( entry ) => {
		setTranscript( ( prev ) => {
			const next = prev.concat( {
				...entry,
				key: `${ Date.now() }-${ Math.random()
					.toString( 36 )
					.slice( 2, 7 ) }`,
			} );
			return next.length > TRANSCRIPT_MAX
				? next.slice( next.length - TRANSCRIPT_MAX )
				: next;
		} );
	}, [] );

	// Reset selection + graph + transcript when the (topology, partition)
	// pair changes — we're effectively starting a fresh REPL session.
	useEffect( () => {
		setSelectedId( null );
		setParsed( { nodes: [], edges: [] } );
		setTranscript( [] );
	}, [ topology, partition ] );

	// Process every incoming SSE msg synchronously. Routing by KEY:
	//   key = 'gui:auto'  → response to one of our own SSE-controller polls;
	//                       feed it to the canvas-parse and never the transcript.
	//   key = '' (empty)  → either a user-typed command's response or an
	//                       async broadcast (debug traces, etc.); show it in
	//                       the transcript verbatim.
	//
	// Synchronous handling is critical: a burst of TM_STRUCT broadcasts
	// could otherwise coalesce React state updates and drop intermediate
	// values (a command response could land BETWEEN auto-fired ls polls
	// and get clobbered by setLastMessage). Callback-based processing
	// guarantees every message is observed.
	//
	// CommandInterpreter copies KEY from each TM_COMMAND request onto its
	// TM_RESPONSE, so the round-trip correlation is automatic.
	const handleMessage = useCallback(
		( msg ) => {
			const value = msg.value;
			let text = null;
			if ( typeof value === 'string' ) {
				text = value;
			} else if (
				value &&
				typeof value === 'object' &&
				typeof value.payload === 'string'
			) {
				text = value.payload;
			}
			if ( msg.key === 'gui:uptime' ) {
				// `09:44:52  up 0 days, 00:01:00\n` → keep the right half.
				const match =
					typeof text === 'string'
						? text.match( /up\s+(.+)$/m )
						: null;
				if ( match ) {
					setUptime( match[ 1 ].trim() );
				}
				return;
			}
			const isOurPoll = msg.key === 'gui:auto';
			if ( ! isOurPoll ) {
				// `debug_level 1+` injects a header BEFORE the curated
				// render — same shape the substrate Dumper produces.
				// Level 1: single-line `<TM_FLAGS> from <from>: <value>`.
				// Level 2: full envelope on one line + value on next.
				// The header always appears regardless of whether the
				// curated render would suppress the message (e.g. TM_EOF
				// at level 0 returns null), so observers can see EVERY
				// arrival at level 1+.
				const level = debugLevelRef.current;
				if ( level >= 2 ) {
					// Level 2 REPLACES the normal render — the envelope
					// dump is the whole payload. Matches the substrate
					// Dumper's `if ($debug_level >= 2) { ... return; }`.
					appendTranscript( {
						kind: 'info',
						text: buildDebugHeader2( msg ),
					} );
					return;
				}
				if ( level >= 1 ) {
					// Level 1 AUGMENTS the normal render with a header
					// line; the curated render below produces the payload.
					appendTranscript( {
						kind: 'info',
						text: buildDebugHeader1( msg ),
					} );
				}
				// User-typed command response, or an async broadcast. Run
				// it through the Dumper-style renderer so each message
				// type gets its appropriate framing.
				const rendered = dumperRender( msg );
				if ( rendered ) {
					appendTranscript( {
						...rendered,
						text: rendered.text.replace( /\n+$/, '' ),
					} );
				}
				return;
			}
			// gui:auto polls only ever emit `dump_metadata` JSON.
			// `text` is the JSON payload string; let parseMetadata
			// handle malformed input gracefully.
			if ( ! text ) {
				return;
			}
			const next = parseMetadata( text );

			// Update per-node rate + last-changed tracking. Same tick
			// drives both — Δcount/Δs gives the msg/s rate, and a
			// non-zero Δcount marks the node as "live, recently active."
			// Also append to a ring-buffer history (cap RATE_HISTORY_MAX
			// samples) so the canvas can draw a per-node sparkline.
			//
			// Byte-rate histories (readHistory / writtenHistory) ride
			// alongside on the same tick so the inspector can plot
			// bytes/s read and written with the same horizontal axis as
			// the msg/s sparkline. A worker respawn resets the counters
			// the same way the message counter resets, so we clamp
			// negatives to zero the same way.
			const now = Date.now() / 1000;
			let touched = false;
			for ( const n of next.nodes ) {
				const prevEntry = rateRef.current.get( n.id );
				const bytesRead = n.bytesRead || 0;
				const bytesWritten = n.bytesWritten || 0;
				// Sticky "has ever been non-zero" flags per stat. The
				// Inspector uses these to gate sparkline rendering — once
				// a stat has seen activity, the plot stays even when the
				// counter resets to 0 (e.g. worker respawn). Prevents
				// graphs from blinking out the moment a worker recycles.
				const hasMessages =
					( prevEntry && prevEntry.hasMessages ) || n.count > 0;
				const hasRead =
					( prevEntry && prevEntry.hasRead ) || bytesRead > 0;
				const hasWritten =
					( prevEntry && prevEntry.hasWritten ) || bytesWritten > 0;
				if ( prevEntry && prevEntry.ts < now ) {
					// A worker respawn resets the counter, so dCount can
					// go strongly negative on the first tick of a new
					// process. Treat that as "rate unknown" (0) — using
					// the raw delta would draw a deep dip below the
					// baseline that misrepresents what just happened.
					const rawDCount = n.count - prevEntry.count;
					const dCount = rawDCount < 0 ? 0 : rawDCount;
					const rawDRead = bytesRead - ( prevEntry.bytesRead || 0 );
					const dRead = rawDRead < 0 ? 0 : rawDRead;
					const rawDWritten =
						bytesWritten - ( prevEntry.bytesWritten || 0 );
					const dWritten = rawDWritten < 0 ? 0 : rawDWritten;
					const dTime = now - prevEntry.ts;
					const rate = dTime > 0 ? dCount / dTime : 0;
					const readRate = dTime > 0 ? dRead / dTime : 0;
					const writtenRate = dTime > 0 ? dWritten / dTime : 0;
					const history = prevEntry.history || [];
					const readHistory = prevEntry.readHistory || [];
					const writtenHistory = prevEntry.writtenHistory || [];
					history.push( rate );
					readHistory.push( readRate );
					writtenHistory.push( writtenRate );
					if ( history.length > RATE_HISTORY_MAX ) {
						history.shift();
					}
					if ( readHistory.length > RATE_HISTORY_MAX ) {
						readHistory.shift();
					}
					if ( writtenHistory.length > RATE_HISTORY_MAX ) {
						writtenHistory.shift();
					}
					rateRef.current.set( n.id, {
						count: n.count,
						bytesRead,
						bytesWritten,
						ts: now,
						rate,
						readRate,
						writtenRate,
						lastChangedTs:
							dCount > 0 ? now : prevEntry.lastChangedTs,
						history,
						readHistory,
						writtenHistory,
						hasMessages,
						hasRead,
						hasWritten,
					} );
					touched = true;
				} else if ( ! prevEntry ) {
					rateRef.current.set( n.id, {
						count: n.count,
						bytesRead,
						bytesWritten,
						ts: now,
						rate: 0,
						readRate: 0,
						writtenRate: 0,
						lastChangedTs: now,
						history: [],
						readHistory: [],
						writtenHistory: [],
						hasMessages,
						hasRead,
						hasWritten,
					} );
					touched = true;
				}
			}
			if ( touched ) {
				setRateVersion( ( v ) => v + 1 );
			}

			// dump_metadata is authoritative on every tick — no
			// need to merge sink data across responses the way the
			// old ls -als + ls -ct dance required.
			setParsed( next );
		},
		[ appendTranscript ]
	);

	const { status, ssePid } = useTopologyStream(
		topology,
		partition,
		handleMessage
	);

	const sendLine = useCallback(
		( line ) => {
			const interpreted = shellInterpret( line );
			if ( ! interpreted ) {
				return;
			}
			// Echo the user's input verbatim so they see what was
			// dispatched. Sigil styling distinguishes outgoing from
			// responses in the transcript.
			appendTranscript( { kind: 'sent', text: line.trim() } );

			if ( interpreted.kind === 'error' ) {
				appendTranscript( { kind: 'error', text: interpreted.text } );
				return;
			}
			if ( interpreted.kind === 'local' ) {
				if ( interpreted.name === 'clear' ) {
					setTranscript( [] );
				} else if ( interpreted.name === 'debug_level' ) {
					// Match the substrate Shell's `debug_level` builtin:
					// no-arg = toggle between 0 and 1; numeric = set
					// explicitly (clamped 0..2). The shellInterpret parser
					// already returns `null` for no-arg and rejects
					// out-of-range numeric input.
					if ( interpreted.level === null ) {
						debugLevelRef.current =
							debugLevelRef.current > 0 ? 0 : 1;
					} else {
						debugLevelRef.current = Math.max(
							0,
							Math.min( 2, interpreted.level )
						);
					}
					appendTranscript( {
						kind: 'info',
						text: `debug_level: ${ debugLevelRef.current }`,
					} );
				}
				return;
			}
			// kind === 'post'
			if ( ! ssePid ) {
				appendTranscript( {
					kind: 'error',
					text: '[no sse_pid yet] retry once CONNECTED',
				} );
				return;
			}
			// `help`: prepend the Shell-builtins blurb so the user sees
			// our local verbs alongside the worker's authoritative
			// server-side list. Mirrors Perl Tachikoma CommandInterpreter::
			// help which prepends `### SHELL BUILTINS ###` from the
			// responder's $shell->help_topics before its own commands.
			if ( interpreted.body.name === 'help' ) {
				appendTranscript( {
					kind: 'info',
					text: SHELL_BUILTINS_BLURB,
				} );
			}
			apiFetch( {
				path: `/newspack-nodes/v1/topology/${ encodeURIComponent(
					topology
				) }/p${ encodeURIComponent( partition ) }/command`,
				method: 'POST',
				data: { ...interpreted.body, sse_pid: ssePid },
			} ).catch( ( err ) => {
				appendTranscript( {
					kind: 'error',
					text: `[POST failed] ${
						( err && err.message ) || 'network error'
					}`,
				} );
			} );
		},
		[ topology, partition, ssePid, appendTranscript ]
	);

	// Inspector action dispatch. Each action maps to a verb the user
	// could have typed at the REPL; routing through sendLine keeps the
	// echo + response visible in the transcript instead of being a
	// silent backchannel.
	const handleInspectorAction = useCallback(
		( action, nodeId, payload ) => {
			if ( action === 'dump' ) {
				sendLine( `dump_node ${ nodeId }` );
			} else if ( action === 'tail' ) {
				sendLine( `connect_node ${ nodeId }` );
			} else if ( action === 'disconnect' ) {
				sendLine( `disconnect_node ${ nodeId }` );
			} else if ( action === 'send' ) {
				sendLine( `send_node ${ nodeId } ${ payload }` );
			} else if ( action === 'trace' ) {
				// payload here is the target level (0 to disable, 1
				// to enable) — Inspector decides based on the current
				// debug_state field from the latest dump_metadata.
				const level = typeof payload === 'number' ? payload : 1;
				sendLine( `debug_state ${ nodeId } ${ level }` );
			}
			// Always pop the transcript open after an Inspector action
			// — the user's expecting to see the worker's reply.
			setReplExpanded( true );
		},
		[ sendLine ]
	);

	// Edit-mode toggle. Entering: snapshot the live parsed as the
	// draft baseline; leaving: pop a confirm modal if the draft has
	// diverged from the (current) live snapshot. The draft is
	// authoritative inside edit mode — SSE pushes don't clobber it.
	const handleModeChange = useCallback(
		( next ) => {
			if ( next === mode ) {
				return;
			}
			if ( next === 'edit' ) {
				const snapshot = {
					nodes: parsed.nodes.slice(),
					edges: parsed.edges.slice(),
				};
				setDraft( snapshot );
				setBaseline( snapshot );
				setMode( 'edit' );
				return;
			}
			// Going back to view: dirty iff the draft has diverged from
			// the snapshot taken at edit-mode entry. Live `parsed` keeps
			// changing under SSE (counters, flowing edges, late-arriving
			// nodes) — if we compared against parsed we'd flag every
			// edit-mode session as dirty even if the operator never
			// touched anything.
			const dirty =
				JSON.stringify( draft ) !== JSON.stringify( baseline );
			if ( ! dirty ) {
				setMode( 'view' );
				return;
			}
			setDiscardModal( {
				onConfirm: () => {
					setDiscardModal( null );
					setMode( 'view' );
				},
				onCancel: () => setDiscardModal( null ),
			} );
		},
		[ mode, parsed, draft, baseline ]
	);

	// View vs edit picks the source of truth for everything downstream:
	// canvas, inspector, node-name lookup. SSE keeps writing `parsed`
	// underneath; the draft is frozen until the user saves or discards.
	const canvasGraph = mode === 'edit' ? draft : parsed;

	// Drop handler — fired by SchematicCanvas when the user releases a
	// palette drag over the SVG. The shellName comes from the
	// dataTransfer payload set by Palette; (x, y) is already projected
	// into SVG-space by the canvas.
	const handleDropNode = useCallback(
		( { shellName, x, y } ) => {
			setDraft( ( g ) => {
				const name = generateNodeName( g, shellName );
				// Seed a position override too — autoLayout would otherwise
				// reposition the freshly-dropped node, defeating the cursor
				// placement. handlePositionChange's setter writes through to
				// localStorage; we use the same path so the placement
				// survives reloads.
				handlePositionChange( name, { x, y } );
				return addNode( g, { shellName, name, x, y } );
			} );
		},
		[ handlePositionChange ]
	);

	// Pull rate info for the selected node. rateVersion is the
	// "something changed in the rate map" signal that drives the
	// useMemo recompute; the actual data lives in rateRef (mutable so
	// hot-path ls -ct ticks don't trigger a full state update per
	// node).
	const selectedRateInfo = useMemo(
		() => ( selectedId ? rateRef.current.get( selectedId ) : null ),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[ selectedId, rateVersion ]
	);

	return (
		<div
			className={ `topology-app${
				selectedId ? ' is-inspector-open' : ''
			}${ mode === 'edit' ? ' is-edit-mode' : '' }` }
		>
			<Header
				topologies={ TOPOLOGIES }
				topology={ topology }
				onTopologyChange={ setTopology }
				partitions={ partitions }
				partition={ partition }
				onPartitionChange={ setPartition }
				streamStatus={ status }
				uptime={ uptime }
				mode={ mode }
				onModeChange={ handleModeChange }
			/>
			{ mode === 'edit' && (
				<Palette
					classes={ catalog.classes }
					loading={ catalog.loading }
				/>
			) }
			<CanvasFrame
				topology={ topology }
				partition={ partition }
				onResetLayout={ hasOverrides ? handleResetLayout : null }
			>
				<SchematicCanvas
					parsed={ canvasGraph }
					selectedId={ selectedId }
					onSelect={ setSelectedId }
					positionOverrides={ positionOverrides }
					onPositionChange={ handlePositionChange }
					onDeselect={ () => setSelectedId( null ) }
					hoveredId={ hoveredId }
					onHover={ setHoveredId }
					rateRef={ rateRef }
					rateVersion={ rateVersion }
					viewport={ viewport }
					onViewportChange={ handleViewportChange }
					editMode={ mode === 'edit' }
					onDropNode={ handleDropNode }
				/>
			</CanvasFrame>
			{ /* Inspector is only mounted when a node is selected — the
			"Select a node to inspect" empty state was a permanent 308px
			of dead pixels. Selecting any node restores the column via
			the `is-inspector-open` class on `.topology-app`. */ }
			{ selectedId && (
				<Inspector
					selectedId={ selectedId }
					parsed={ canvasGraph }
					streamStatus={ status }
					rateInfo={ selectedRateInfo }
					onAction={ handleInspectorAction }
					onSelect={ setSelectedId }
					onHover={ setHoveredId }
					nodeIds={
						new Set( canvasGraph.nodes.map( ( n ) => n.id ) )
					}
					ssePid={ ssePid }
				/>
			) }
			<ReplFooter
				topology={ topology }
				partition={ partition }
				streamStatus={ status }
				canSend={ status === 'open' && !! ssePid }
				onSubmit={ sendLine }
				onClear={ () => setTranscript( [] ) }
				transcript={ transcript }
				expanded={ replExpanded }
				onExpandedChange={ setReplExpanded }
			/>
			{ discardModal && (
				<ConfirmModal
					title="Discard unsaved changes?"
					body="Leaving edit mode drops the draft topology. This cannot be undone."
					confirmLabel="Discard"
					cancelLabel="Keep editing"
					danger
					onConfirm={ discardModal.onConfirm }
					onCancel={ discardModal.onCancel }
				/>
			) }
		</div>
	);
}
