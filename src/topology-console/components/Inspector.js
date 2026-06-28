/**
 * Right-pane inspector for the selected node.
 */

import { useEffect, useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { ModalShell, PromptModal } from './Modal';
import { CtorField } from './CtorField';
import TimeTravelPanel from './TimeTravelPanel';
import { computePollIntervalMs } from '../../runtime/metadata-node';
import { processStats } from '../utils/processStats';
import { Sparkline } from '../../event-dashboards/Sparkline';
import { useNodeState } from '../../runtime/react';
import reservedNames from '../../runtime/reserved-node-names.json';

// A Consumer (or its Tail subclass) is the node whose dump_metadata carries a
// `frames` array AND a `cursor` (its dump_metadata() read surface) — the
// data the inspector already holds, no request verb and no class-name list.
// Reserved/plumbing nodes without frames+cursor don't qualify.
function isConsumerNode( node ) {
	return Array.isArray( node?.frames ) && !! node?.cursor;
}

// The Inspector hides config-edit affordances (Routing/Constructor/Verbs/
// rename/Delete/class-catalog verb buttons) for the worker-auto-mounted
// `_repl` anchor only. Edit-mode draft nodes carry `reserved: true` (set by
// `withReplAnchor`); live-mode `parseMetadata` doesn't tag, so the id check
// catches `_repl` there. Every OTHER node — including other spine names
// (_metadata, _http, _output, …) — stays freely inspectable.
function isReserved( node ) {
	return !! ( node && ( node.reserved || '_repl' === node.id ) );
}

function FieldRow( { k, v, vClass } ) {
	return (
		<div className="topology-field-row">
			<span className="topology-field-row__key">{ k }</span>
			<span
				className={ `topology-field-row__val${
					vClass ? ' ' + vClass : ''
				}` }
			>
				{ v }
			</span>
		</div>
	);
}

// Clickable node-name links; unknown names render as plain dim text.
function NodeLinks( { names, nodeIds, onSelect, onHover } ) {
	if ( ! names || ! names.length ) {
		return (
			<span className="topology-field-row__val topology-field-row__val--dim">
				—
			</span>
		);
	}
	return (
		<span className="topology-field-row__val">
			{ names.map( ( name, i ) => {
				const known = nodeIds && nodeIds.has( name );
				const sep = i < names.length - 1 ? ', ' : '';
				if ( ! known ) {
					return (
						<span
							key={ name }
							className="topology-field-row__val--dim"
						>
							{ name }
							{ sep }
						</span>
					);
				}
				return (
					<span key={ name }>
						<button
							type="button"
							className="topology-field-row__nav"
							onClick={ () => onSelect && onSelect( name ) }
							onMouseEnter={ () => onHover && onHover( name ) }
							onMouseLeave={ () => onHover && onHover( null ) }
						>
							{ name }
						</button>
						{ sep }
					</span>
				);
			} ) }
		</span>
	);
}

function Section( { title, meta, children } ) {
	return (
		<div className="topology-insp__section">
			<h4 className="topology-insp__section-title">
				{ title }
				{ meta && (
					<span className="topology-insp__section-meta">
						{ meta }
					</span>
				) }
			</h4>
			{ children }
		</div>
	);
}

function formatRate( rate ) {
	if ( rate === undefined || rate === null ) {
		return '— /s';
	}
	if ( rate === 0 ) {
		return '0 /s';
	}
	if ( rate >= 100 ) {
		return `${ Math.round( rate ) } /s`;
	}
	if ( rate >= 1 ) {
		return `${ rate.toFixed( 1 ) } /s`;
	}
	return `${ rate.toFixed( 2 ) } /s`;
}

// Bytes-per-second formatter.
function formatByteRate( rate ) {
	if ( rate === undefined || rate === null ) {
		return '— /s';
	}
	if ( rate < 1 ) {
		return '0 B/s';
	}
	if ( rate < 1024 ) {
		return `${ Math.round( rate ) } B/s`;
	}
	if ( rate < 1024 * 1024 ) {
		return `${ ( rate / 1024 ).toFixed( 1 ) } K/s`;
	}
	if ( rate < 1024 * 1024 * 1024 ) {
		return `${ ( rate / ( 1024 * 1024 ) ).toFixed( 1 ) } M/s`;
	}
	return `${ ( rate / ( 1024 * 1024 * 1024 ) ).toFixed( 1 ) } G/s`;
}

/**
 * Split a node's raw `arguments` string into `count` positional values for the
 * read-only Constructor view. The LAST declared arg captures any remainder, so a
 * free-form trailing argument (e.g. a forwarded command's own args) reads as one
 * value instead of spilling across rows.
 *
 * @param {string} raw   The node's space-separated arguments string.
 * @param {number} count Number of positional args the class declares.
 * @return {string[]} Positional values, length <= count.
 */
function positionalArgs( raw, count ) {
	const trimmed = ( raw || '' ).trim();
	if ( ! trimmed || count <= 0 ) {
		return [];
	}
	const tokens = trimmed.split( /\s+/ );
	if ( tokens.length <= count ) {
		return tokens;
	}
	return [
		...tokens.slice( 0, count - 1 ),
		tokens.slice( count - 1 ).join( ' ' ),
	];
}

// Inspector sparkline (wider/taller variant of the node-card one).
const INSP_SPARK_HISTORY_MAX = 60;

// Honest "last ~Ns" label for the Activity sparkline. It holds
// INSP_SPARK_HISTORY_MAX samples, one per metadata poll, and the poll cadence
// scales with graph size (computePollIntervalMs) — so the real trailing window
// is sample-count * interval, not a fixed minute. Rolls to minutes past 120s.
export function formatActivityWindow( nodeCount ) {
	const windowSec =
		( INSP_SPARK_HISTORY_MAX * computePollIntervalMs( nodeCount ) ) / 1000;
	if ( windowSec < 120 ) {
		return sprintf(
			// translators: %d: trailing activity window length in seconds.
			__( 'last ~%ds', 'newspack-nodes' ),
			Math.round( windowSec )
		);
	}
	return sprintf(
		// translators: %d: trailing activity window length in minutes.
		__( 'last ~%dm', 'newspack-nodes' ),
		Math.round( windowSec / 60 )
	);
}
function inspectorSparklinePath( history, width, height ) {
	if ( ! history || history.length < 2 ) {
		return null;
	}
	const max = Math.max( ...history, 1e-9 );
	const step = width / ( INSP_SPARK_HISTORY_MAX - 1 );
	const startIdx = INSP_SPARK_HISTORY_MAX - history.length;
	return history
		.map( ( v, i ) => {
			const safeV = v > 0 ? v : 0;
			const x = ( startIdx + i ) * step;
			const y = height - ( safeV / max ) * height;
			return `${ i === 0 ? 'M' : 'L' } ${ x.toFixed( 2 ) },${ y.toFixed(
				2
			) }`;
		} )
		.join( ' ' );
}

// One labeled sparkline row; peak label makes the auto-scaled curve readable.
function SparklineRow( { label, history, currentValue, format } ) {
	const W = 270;
	const H = 32;
	const path = inspectorSparklinePath( history, W, H );
	const peak = history && history.length ? Math.max( ...history, 0 ) : 0;
	return (
		<div className="topology-insp__spark-row">
			<div className="topology-insp__spark-head">
				<span className="topology-insp__spark-label">{ label }</span>
				<span className="topology-insp__spark-vals">
					<span
						className={ `topology-insp__spark-val${
							currentValue > 0
								? ''
								: ' topology-insp__spark-val--dim'
						}` }
					>
						{ format( currentValue ) }
					</span>
					<span className="topology-insp__spark-peak">
						{ __( 'peak', 'newspack-nodes' ) } { format( peak ) }
					</span>
				</span>
			</div>
			<svg
				className="topology-insp__spark-svg"
				viewBox={ `0 0 ${ W } ${ H }` }
				preserveAspectRatio="none"
				aria-hidden="true"
			>
				{ path && (
					<path
						d={ path }
						className="topology-insp__spark-path"
						fill="none"
					/>
				) }
			</svg>
		</div>
	);
}

// Bytes with K/M/G suffixes for glanceable values.
function formatBytes( n ) {
	if ( typeof n !== 'number' || n < 0 ) {
		return '—';
	}
	if ( n < 1024 ) {
		return `${ n } B`;
	}
	if ( n < 1024 * 1024 ) {
		return `${ ( n / 1024 ).toFixed( 1 ) } K`;
	}
	if ( n < 1024 * 1024 * 1024 ) {
		return `${ ( n / ( 1024 * 1024 ) ).toFixed( 1 ) } M`;
	}
	return `${ ( n / ( 1024 * 1024 * 1024 ) ).toFixed( 1 ) } G`;
}

// Process-stats header for the no-node inspector (roadmap [95]). Everything is
// scoped to the process being viewed (whatever `_cwd` points at): messages-in/out
// + bytes roll up from the live dump_metadata graph (processStats); the In/Out
// rate `rateSeries` is accumulated by the always-mounted GraphView (so it
// survives this header un/remounting on node-select or panel-collapse) and the
// error/warning/debug counts come from a `dmesg` of that process (the `_dmesg`
// poll node classifies the stderr tail).
function ProcessStatsHeader( { nodes, rateSeries } ) {
	const { messagesIn, messagesOut, bytesRead, bytesWritten } =
		processStats( nodes );
	const { in: inSpark = [], out: outSpark = [] } = rateSeries || {};
	const levels = useNodeState( reservedNames.DMESG, 'dmesg' ) || {
		errors: 0,
		warnings: 0,
		debug: 0,
	};
	const cell = ( label, value, spark ) => (
		<div className="topology-insp__stat">
			<span className="topology-insp__stat-label">{ label }</span>
			<span className="topology-insp__stat-val">{ value }</span>
			{ spark }
		</div>
	);
	return (
		<div
			className="topology-insp__stats"
			data-testid="inspector-process-stats"
		>
			<div className="topology-insp__stat-grid">
				{ cell(
					__( 'Msgs in', 'newspack-nodes' ),
					messagesIn.toLocaleString(),
					<Sparkline values={ inSpark } width={ 84 } height={ 16 } />
				) }
				{ cell(
					__( 'Msgs out', 'newspack-nodes' ),
					messagesOut.toLocaleString(),
					<Sparkline values={ outSpark } width={ 84 } height={ 16 } />
				) }
				{ cell(
					__( 'Bytes read', 'newspack-nodes' ),
					formatBytes( bytesRead )
				) }
				{ cell(
					__( 'Bytes written', 'newspack-nodes' ),
					formatBytes( bytesWritten )
				) }
			</div>
			<div className="topology-insp__levels">
				<span className="topology-insp__level topology-insp__level--error">
					{ sprintf(
						// translators: %d: error line count.
						__( '%d err', 'newspack-nodes' ),
						levels.errors
					) }
				</span>
				<span className="topology-insp__level topology-insp__level--warn">
					{ sprintf(
						// translators: %d: warning line count.
						__( '%d warn', 'newspack-nodes' ),
						levels.warnings
					) }
				</span>
				<span className="topology-insp__level topology-insp__level--debug">
					{ sprintf(
						// translators: %d: debug line count.
						__( '%d dbg', 'newspack-nodes' ),
						levels.debug
					) }
				</span>
			</div>
		</div>
	);
}

function formatLastSeen( ts, live ) {
	if ( ts === undefined || ts === null ) {
		return live ? __( 'streaming', 'newspack-nodes' ) : '—';
	}
	const ago = Date.now() / 1000 - ts;
	if ( ago < 1 ) {
		return __( 'just now', 'newspack-nodes' );
	}
	if ( ago < 60 ) {
		return sprintf(
			// translators: %s: seconds since last activity.
			__( '%ss ago', 'newspack-nodes' ),
			ago.toFixed( 1 )
		);
	}
	if ( ago < 3600 ) {
		return sprintf(
			// translators: %d: minutes since last activity.
			__( '%dm ago', 'newspack-nodes' ),
			Math.round( ago / 60 )
		);
	}
	return sprintf(
		// translators: %d: hours since last activity.
		__( '%dh ago', 'newspack-nodes' ),
		Math.round( ago / 3600 )
	);
}

// Edit-mode form: schema-driven Constructor + Verbs sections for the draft node.

function NameField( { node, takenNames, onRenameNode } ) {
	const [ value, setValue ] = useState( node.id );
	const [ error, setError ] = useState( '' );

	// Reset the local input when the selected node changes.
	useEffect( () => {
		setValue( node.id );
		setError( '' );
	}, [ node.id ] );

	const validate = ( raw ) => {
		const trimmed = String( raw || '' ).trim();
		if ( ! trimmed ) {
			return __( 'Name cannot be empty.', 'newspack-nodes' );
		}
		if ( trimmed === node.id ) {
			return '';
		}
		if ( takenNames.has( trimmed ) ) {
			return sprintf(
				// translators: %s: the node name the user tried to use.
				__( "Name '%s' already in use.", 'newspack-nodes' ),
				trimmed
			);
		}
		if ( ! /^[a-zA-Z0-9._:-]+$/.test( trimmed ) ) {
			return __(
				'Letters, digits, dot, dash, underscore, colon only.',
				'newspack-nodes'
			);
		}
		return '';
	};

	const commit = () => {
		const trimmed = value.trim();
		const err = validate( trimmed );
		if ( err ) {
			setError( err );
			return;
		}
		if ( trimmed === node.id ) {
			return;
		}
		const ok = onRenameNode && onRenameNode( node.id, trimmed );
		if ( ! ok ) {
			// Caller refused (collision raced in) — snap back and explain.
			setValue( node.id );
			setError(
				__( 'Rename refused — name already taken.', 'newspack-nodes' )
			);
		}
	};

	return (
		<div className="topology-edit-row">
			<label
				htmlFor="topology-name-field"
				className="topology-edit-row__label"
			>
				name
			</label>
			<input
				id="topology-name-field"
				className="topology-edit-row__input"
				type="text"
				value={ value }
				onChange={ ( e ) => {
					setValue( e.target.value );
					setError( validate( e.target.value ) );
				} }
				onBlur={ commit }
				onKeyDown={ ( e ) => {
					if ( e.key === 'Enter' ) {
						e.preventDefault();
						e.target.blur();
					}
					if ( e.key === 'Escape' ) {
						setValue( node.id );
						setError( '' );
						e.target.blur();
					}
				} }
			/>
			{ error && (
				<span className="topology-edit-row__hint">{ error }</span>
			) }
		</div>
	);
}

function VerbRow( {
	spec,
	invocation,
	onToggle,
	onArgChange,
	onRemove,
	multiple = false,
	nodeNames = [],
	formatters = [],
} ) {
	const checked = !! invocation;
	const id = `topology-verb-${ spec.name }`;
	// A `multiple` verb has one row per invocation (always present, removable),
	// not a single checkbox — the operator wires N independent mappings.
	const showArgs =
		( multiple || checked ) &&
		invocation &&
		spec.args &&
		spec.args.length > 0;
	return (
		<div className="topology-edit-verb">
			{ multiple ? (
				<div className="topology-edit-row topology-edit-verb__head">
					<span className="topology-edit-row__label">
						<code>{ spec.name }</code>
					</span>
					<button
						type="button"
						className="topology-edit-verb__remove"
						aria-label={ `Remove ${ spec.name }` }
						onClick={ onRemove }
					>
						×
					</button>
				</div>
			) : (
				<label
					className="topology-edit-row"
					htmlFor={ id }
					aria-label={ spec.name }
				>
					<input
						id={ id }
						type="checkbox"
						checked={ checked }
						onChange={ ( e ) => onToggle( e.target.checked ) }
					/>
					<span className="topology-edit-row__label">
						<code>{ spec.name }</code>
					</span>
				</label>
			) }
			{ showArgs && (
				<div className="topology-edit-verb__args">
					{ spec.args.map( ( arg, i ) => (
						<CtorField
							key={ arg.name }
							spec={ arg }
							value={ invocation.args[ i ] }
							nodeNames={ nodeNames }
							formatters={ formatters }
							onChange={ ( v ) => onArgChange( i, v ) }
						/>
					) ) }
				</div>
			) }
		</div>
	);
}

// Live metadata wins, else the class catalog default, else true — mirrors the
// SchematicCanvas OUT-port gating so a sink-only node shows no routing UI.
function nodeHasTarget( node, catalog ) {
	const schema = catalog.find( ( c ) => c.shell_name === node.class );
	return node.has_target ?? schema?.has_target ?? true;
}

// A Tee-family fan-out node, per the catalog `is_tee` flag (both edit + view
// modes carry the class catalog). Falls back to the runtime target shape when
// the catalog lacks the class — in edit mode `target` is a string, so the
// catalog flag is the only reliable signal there.
function isTeeNode( node, catalog ) {
	const schema = catalog.find( ( c ) => c.shell_name === node.class );
	return schema?.is_tee ?? Array.isArray( node.target );
}

// Tee fans out to many targets; everything else has a single target.
function TargetsField( {
	node,
	nodeNames,
	targets,
	catalog,
	onConnect,
	onRemoveEdge,
} ) {
	// A Tee-family fan-out node gets the multi-target editor; everything else a
	// single target. Keys off the catalog is_tee flag (both modes carry it), so
	// any Tee subclass gets the multi-target editor regardless of target shape.
	const isTee = isTeeNode( node, catalog );
	const datalistId = `topology-targets-${ node.id }`;
	if ( isTee ) {
		return (
			<TeeTargetsField
				node={ node }
				nodeNames={ nodeNames }
				targets={ targets }
				datalistId={ datalistId }
				onConnect={ onConnect }
				onRemoveEdge={ onRemoveEdge }
			/>
		);
	}
	return (
		<SingleTargetField
			node={ node }
			nodeNames={ nodeNames }
			targets={ targets }
			datalistId={ datalistId }
			onConnect={ onConnect }
			onRemoveEdge={ onRemoveEdge }
		/>
	);
}

function TeeTargetsField( {
	node,
	nodeNames,
	targets,
	onConnect,
	onRemoveEdge,
} ) {
	// Available = every other node not already wired from this Tee.
	const wired = new Set(
		targets.filter( ( e ) => ! e.virtual ).map( ( e ) => e.to )
	);
	const available = nodeNames.filter( ( n ) => ! wired.has( n ) );

	return (
		<div className="topology-edit-row">
			<span className="topology-edit-row__label">targets</span>
			<div className="topology-edit-chips">
				{ targets.map( ( e ) => (
					<RoutingChip
						key={ `${ e.from }->${ e.to }` }
						label={ e.to }
						virtual={ e.virtual }
						onClear={
							onRemoveEdge && ! e.virtual
								? () => onRemoveEdge( e.from, e.to )
								: null
						}
					/>
				) ) }
				{ available.length > 0 && (
					<select
						className="topology-edit-add-chip"
						value=""
						onChange={ ( e ) => {
							if ( ! e.target.value || ! onConnect ) {
								return;
							}
							onConnect( node.id, e.target.value );
						} }
					>
						<option value="">
							{ __( '+ add target…', 'newspack-nodes' ) }
						</option>
						{ available.map( ( n ) => (
							<option key={ n } value={ n }>
								{ n }
							</option>
						) ) }
					</select>
				) }
				{ available.length === 0 && targets.length === 0 && (
					<span className="topology-edit-row__hint">
						{ __(
							'No other nodes to wire to yet.',
							'newspack-nodes'
						) }
					</span>
				) }
			</div>
		</div>
	);
}

function SingleTargetField( {
	node,
	nodeNames,
	targets,
	onConnect,
	onRemoveEdge,
} ) {
	// Physical edge only; virtual (verb-derived) edges live in the Verbs section.
	const physical = targets.find( ( e ) => ! e.virtual ) || null;
	const currentTarget = physical ? physical.to : '';

	const handleChange = ( next ) => {
		if ( next === currentTarget ) {
			return;
		}
		if ( next === '' ) {
			if ( physical && onRemoveEdge ) {
				onRemoveEdge( physical.from, physical.to );
			}
			return;
		}
		if ( onConnect ) {
			// The non-Tee branch replaces the existing target automatically.
			onConnect( node.id, next );
		}
	};

	// Options = every other node, plus the current target if not in the draft.
	const options = nodeNames.slice();
	if ( currentTarget && ! options.includes( currentTarget ) ) {
		options.push( currentTarget );
	}

	return (
		<div className="topology-edit-row">
			<label
				htmlFor={ `topology-target-input-${ node.id }` }
				className="topology-edit-row__label"
			>
				target
			</label>
			<select
				id={ `topology-target-input-${ node.id }` }
				className="topology-edit-row__input"
				value={ currentTarget }
				onChange={ ( e ) => handleChange( e.target.value ) }
			>
				<option value="">{ __( '(none)', 'newspack-nodes' ) }</option>
				{ options.map( ( n ) => (
					<option key={ n } value={ n }>
						{ n }
					</option>
				) ) }
			</select>
			{ targets.some( ( e ) => e.virtual ) && (
				<span className="topology-edit-row__hint">
					{ __(
						'Plus virtual edge(s) from verb args — manage in Verbs.',
						'newspack-nodes'
					) }
				</span>
			) }
		</div>
	);
}

function RoutingChip( { label, virtual, onClear } ) {
	return (
		<span
			className={ `topology-edit-chip${
				virtual ? ' topology-edit-chip--virtual' : ''
			}` }
		>
			<code className="topology-edit-chip__name">{ label }</code>
			{ onClear && ! virtual && (
				<button
					type="button"
					className="topology-edit-chip__clear"
					aria-label={ sprintf(
						// translators: %s: target node name to remove.
						__( 'Remove %s', 'newspack-nodes' ),
						label
					) }
					onClick={ onClear }
				>
					×
				</button>
			) }
		</span>
	);
}

function EditForm( {
	node,
	catalog,
	formatters,
	parsed,
	onUpdateArgs,
	onUpdateVerbs,
	onRemoveNode,
	onRenameNode,
	onRemoveEdge,
	onConnect,
} ) {
	const schema = catalog.find( ( c ) => c.shell_name === node.class ) || null;
	const argumentSpecs = schema?.arguments || [];
	// Hidden verbs (e.g. Tail's time-travel set_snapshot_node/seek_frame/…) are
	// schema plumbing, not operator-facing config — keep them out of the editor,
	// matching the runtime action-button filter below.
	const commandSpecs = ( schema?.commands || [] ).filter(
		( spec ) => ! spec.hidden
	);
	const ctorArgs = node.ctorArgs || [];
	const verbInvocations = node.verbInvocations || [];
	// Names of every other draft node, for node_name verb-arg selects.
	const nodeNames = ( parsed?.nodes || [] )
		.map( ( n ) => n.name || n.id )
		.filter( ( n ) => n && n !== node.id );

	return (
		<aside className="topology-inspector">
			<h2 className="topology-insp__title">{ node.id }</h2>
			<div className="topology-insp__type">
				{ node.class || '?' } · { __( 'EDIT', 'newspack-nodes' ) }
			</div>

			{ onRemoveNode && ! isReserved( node ) && (
				<button
					type="button"
					className="topology-edit-delete"
					onClick={ () => onRemoveNode( node.id ) }
				>
					{ __( 'Delete node', 'newspack-nodes' ) }
				</button>
			) }

			{ /* Reserved anchors (e.g. _repl) are auto-mounted and fixed: no rename. */ }
			{ ! isReserved( node ) && (
				<Section title={ __( 'Identity', 'newspack-nodes' ) }>
					<NameField
						node={ node }
						takenNames={
							new Set(
								( parsed?.nodes || [] )
									.map( ( n ) => n.id )
									.filter( ( id ) => id !== node.id )
							)
						}
						onRenameNode={ onRenameNode }
					/>
				</Section>
			) }

			{ ! isReserved( node ) && nodeHasTarget( node, catalog ) && (
				<Section title={ __( 'Routing', 'newspack-nodes' ) }>
					<TargetsField
						node={ node }
						nodeNames={ nodeNames }
						catalog={ catalog }
						targets={ ( parsed?.edges || [] ).filter(
							( e ) => e.from === node.id
						) }
						onConnect={ onConnect }
						onRemoveEdge={ onRemoveEdge }
					/>
				</Section>
			) }

			{ ! isReserved( node ) && (
				<Section title={ __( 'Constructor', 'newspack-nodes' ) }>
					{ argumentSpecs.length === 0 && (
						<div className="topology-edit-empty">
							{ __(
								'No constructor arguments.',
								'newspack-nodes'
							) }
						</div>
					) }
					{ argumentSpecs.map( ( spec, i ) => (
						<CtorField
							key={ spec.name }
							spec={ spec }
							value={ ctorArgs[ i ] }
							nodeNames={ nodeNames }
							formatters={ formatters }
							onChange={ ( v ) => {
								const next = ctorArgs.slice();
								next[ i ] = v;
								if ( onUpdateArgs ) {
									onUpdateArgs( node.id, next );
								}
							} }
						/>
					) ) }
				</Section>
			) }

			{ ! isReserved( node ) && (
				<Section title={ __( 'Verbs', 'newspack-nodes' ) }>
					{ commandSpecs.length === 0 && (
						<div className="topology-edit-empty">
							{ __( 'No verbs registered.', 'newspack-nodes' ) }
						</div>
					) }
					{ commandSpecs.map( ( cspec ) => {
						// A `multiple` verb wires N independent invocations (e.g.
						// settings-sync's 13 add_setting mappings): render a row per
						// invocation + an Add button, not one checkbox.
						if ( cspec.multiple ) {
							const invIdxs = verbInvocations
								.map( ( inv, i ) =>
									inv.verb === cspec.name ? i : -1
								)
								.filter( ( i ) => i >= 0 );
							const handleAdd = () => {
								if ( ! onUpdateVerbs ) {
									return;
								}
								onUpdateVerbs( node.id, [
									...verbInvocations,
									{
										verb: cspec.name,
										args: ( cspec.args || [] ).map(
											() => ''
										),
									},
								] );
							};
							return (
								<div
									key={ cspec.name }
									className="topology-edit-verb-group"
								>
									{ invIdxs.map( ( invIdx ) => (
										<VerbRow
											key={ invIdx }
											spec={ cspec }
											invocation={
												verbInvocations[ invIdx ]
											}
											multiple
											nodeNames={ nodeNames }
											formatters={ formatters }
											onArgChange={ ( argIdx, value ) => {
												if ( ! onUpdateVerbs ) {
													return;
												}
												const next =
													verbInvocations.slice();
												const args =
													next[ invIdx ].args.slice();
												args[ argIdx ] = value;
												next[ invIdx ] = {
													...next[ invIdx ],
													args,
												};
												onUpdateVerbs( node.id, next );
											} }
											onRemove={ () => {
												if ( ! onUpdateVerbs ) {
													return;
												}
												const next =
													verbInvocations.slice();
												next.splice( invIdx, 1 );
												onUpdateVerbs( node.id, next );
											} }
										/>
									) ) }
									<button
										type="button"
										className="topology-edit-verb__add"
										onClick={ handleAdd }
									>
										{ `+ Add ${ cspec.name }` }
									</button>
								</div>
							);
						}
						const idx = verbInvocations.findIndex(
							( inv ) => inv.verb === cspec.name
						);
						const invocation =
							idx >= 0 ? verbInvocations[ idx ] : null;
						const handleToggle = ( on ) => {
							if ( ! onUpdateVerbs ) {
								return;
							}
							if ( on && idx < 0 ) {
								onUpdateVerbs( node.id, [
									...verbInvocations,
									{
										verb: cspec.name,
										args: ( cspec.args || [] ).map(
											() => ''
										),
									},
								] );
							} else if ( ! on && idx >= 0 ) {
								const next = verbInvocations.slice();
								next.splice( idx, 1 );
								onUpdateVerbs( node.id, next );
							}
						};
						const handleArgChange = ( argIdx, value ) => {
							if ( ! onUpdateVerbs || idx < 0 ) {
								return;
							}
							const next = verbInvocations.slice();
							const args = next[ idx ].args.slice();
							args[ argIdx ] = value;
							next[ idx ] = { ...next[ idx ], args };
							onUpdateVerbs( node.id, next );
						};
						return (
							<VerbRow
								key={ cspec.name }
								spec={ cspec }
								invocation={ invocation }
								nodeNames={ nodeNames }
								formatters={ formatters }
								onToggle={ handleToggle }
								onArgChange={ handleArgChange }
							/>
						);
					} ) }
				</Section>
			) }
		</aside>
	);
}

// Modal collecting a verb's args via the same CtorField widgets edit mode uses,
// then firing onAction('invoke', …) with positional + by-name argument forms.
function VerbArgModal( {
	nodeId,
	verb,
	kind,
	args,
	formatters,
	nodeNames,
	onAction,
	onDismiss,
} ) {
	const [ values, setValues ] = useState( () =>
		args.map( ( arg ) => arg.default ?? '' )
	);

	const missingRequired = args.some(
		( arg, i ) => arg.required && '' === String( values[ i ] ?? '' ).trim()
	);

	const run = () => {
		if ( missingRequired ) {
			return;
		}
		const filled = [];
		const byName = {};
		args.forEach( ( arg, i ) => {
			const v = values[ i ];
			if ( v === undefined || '' === String( v ) ) {
				return;
			}
			filled.push( String( v ) );
			byName[ arg.name ] = v;
		} );
		onAction( 'invoke', nodeId, {
			verb,
			kind,
			positional: filled.join( ' ' ).trim(),
			byName,
		} );
		onDismiss();
	};

	return (
		<ModalShell title={ verb } onDismiss={ onDismiss }>
			<div className="topology-modal__body">
				{ args.map( ( arg, i ) => (
					<CtorField
						key={ arg.name }
						spec={ arg }
						value={ values[ i ] }
						nodeNames={ nodeNames }
						formatters={ formatters }
						onChange={ ( v ) =>
							setValues( ( prev ) => {
								const next = prev.slice();
								next[ i ] = v;
								return next;
							} )
						}
					/>
				) ) }
			</div>
			<div className="topology-modal__actions">
				<button
					type="button"
					className="topology-modal__btn"
					onClick={ onDismiss }
				>
					{ __( 'Cancel', 'newspack-nodes' ) }
				</button>
				<button
					type="button"
					className="topology-modal__btn topology-modal__btn--primary"
					onClick={ run }
					disabled={ missingRequired }
				>
					{ __( 'Run', 'newspack-nodes' ) }
				</button>
			</div>
		</ModalShell>
	);
}

// One schema verb button. Argless verbs fire immediately; verbs with args open
// the VerbArgModal. `kind` is 'command' (TM_COMMAND) or 'request' (TM_REQUEST).
function VerbButton( { nodeId, spec, kind, formatters, nodeNames, onAction } ) {
	const [ open, setOpen ] = useState( false );
	const hasArgs = spec.args && spec.args.length > 0;
	const verbLabel =
		'request' === kind ? `TM_REQUEST ${ spec.name }` : spec.name;
	return (
		<>
			<button
				type="button"
				className="topology-insp__actions-full"
				onClick={ () => {
					if ( ! onAction ) {
						return;
					}
					if ( hasArgs ) {
						setOpen( true );
						return;
					}
					onAction( 'invoke', nodeId, {
						verb: spec.name,
						kind,
						positional: '',
						byName: {},
					} );
				} }
				title={
					spec.description ||
					sprintf(
						// translators: %s: verb name (prefixed with TM_REQUEST for request verbs).
						__( 'Send %s', 'newspack-nodes' ),
						verbLabel
					)
				}
			>
				{ spec.name }
			</button>
			{ open && (
				<VerbArgModal
					nodeId={ nodeId }
					verb={ spec.name }
					kind={ kind }
					args={ spec.args }
					formatters={ formatters }
					nodeNames={ nodeNames }
					onAction={ onAction }
					onDismiss={ () => setOpen( false ) }
				/>
			) }
		</>
	);
}

// No-node inspector quick-commands: server-wide verbs that don't operate on a
// selected node (roadmap [48]). Each dispatches its raw command via onAction's
// generic `command` action; args-taking verbs (log/ping) show their usage in the
// transcript, same as typing them bare in the REPL.
// Value-taking selected-node verbs (roadmap [48]): each button opens ONE shared
// prompt modal keyed by verb; onConfirm dispatches onAction(verb, node.id, value).
const PROMPT_VERBS = {
	send: { label: 'Send', noun: 'bytes' },
	tell: { label: 'Tell', noun: 'info' },
	send_struct: { label: 'Struct', noun: 'JSON' },
};

const NO_NODE_COMMANDS = [
	[ 'trace', 'debug_state *' ],
	[ 'debug', 'debug_level' ],
	[ 'verbose', 'debug_level 2' ],
	[ 'dmesg', 'dmesg' ],
	[ 'config', 'dump_config' ],
	[ 'metadata', 'dump_metadata' ],
	[ 'stats', 'stats' ],
	[ 'ping', 'ping' ],
];

// Register modal (roadmap [48]-C): wire a listener node to one of the source
// node's valid registration events. Confirm dispatches `register <source>
// <target> <event>` via onAction('register', source, `${target} ${event}`).
function RegisterModal( { source, events, nodeNames, onConfirm, onCancel } ) {
	const [ event, setEvent ] = useState( events[ 0 ] || '' );
	const [ target, setTarget ] = useState( nodeNames[ 0 ] || '' );
	return (
		<ModalShell
			title={ sprintf(
				// translators: %s: the source node id.
				__( 'Register a listener on %s', 'newspack-nodes' ),
				source
			) }
			onDismiss={ onCancel }
		>
			<div className="topology-modal__body">
				<label
					className="topology-modal__label"
					htmlFor="nodes-register-event"
				>
					{ __( 'Event', 'newspack-nodes' ) }
					<select
						id="nodes-register-event"
						className="topology-modal__input"
						value={ event }
						onChange={ ( e ) => setEvent( e.target.value ) }
					>
						{ events.map( ( ev ) => (
							<option key={ ev } value={ ev }>
								{ ev }
							</option>
						) ) }
					</select>
				</label>
				<label
					className="topology-modal__label"
					htmlFor="nodes-register-target"
				>
					{ __( 'Listener node', 'newspack-nodes' ) }
					<select
						id="nodes-register-target"
						className="topology-modal__input"
						value={ target }
						onChange={ ( e ) => setTarget( e.target.value ) }
					>
						{ nodeNames.map( ( n ) => (
							<option key={ n } value={ n }>
								{ n }
							</option>
						) ) }
					</select>
				</label>
			</div>
			<div className="topology-modal__actions">
				<button
					type="button"
					className="topology-modal__btn"
					onClick={ onCancel }
				>
					{ __( 'Cancel', 'newspack-nodes' ) }
				</button>
				<button
					type="button"
					className="topology-modal__btn topology-modal__btn--primary"
					disabled={ ! event || ! target }
					onClick={ () => onConfirm( target, event ) }
				>
					{ __( 'Register', 'newspack-nodes' ) }
				</button>
			</div>
		</ModalShell>
	);
}

// Message-composer types (roadmap [46]): each maps to a CLI verb so Compose has
// full CLI equivalence. [ label, onAction-action, takesValue ].
const COMPOSE_TYPES = [
	[ 'TM_BYTESTREAM (send_node)', 'send', true ],
	[ 'TM_INFO (tell_node)', 'tell', true ],
	[ 'TM_STRUCT (send_struct)', 'send_struct', true ],
	[ 'TM_REQUEST (request_node)', 'request', true ],
	[ 'TM_EOF (send_eof)', 'send_eof', false ],
];

// Compose modal (roadmap [46]): a message-composer playground — pick a target +
// message TYPE + value, dispatched via the matching CLI verb (full equivalence
// with the REPL). Confirm calls onConfirm(action, to, value).
function ComposeModal( { nodeNames, onConfirm, onCancel } ) {
	const [ to, setTo ] = useState( nodeNames[ 0 ] || '' );
	const [ typeIdx, setTypeIdx ] = useState( 0 );
	const [ value, setValue ] = useState( '' );
	const [ , action, takesValue ] = COMPOSE_TYPES[ typeIdx ];
	return (
		<ModalShell
			title={ __( 'Compose a message', 'newspack-nodes' ) }
			onDismiss={ onCancel }
		>
			<div className="topology-modal__body">
				<label
					className="topology-modal__label"
					htmlFor="nodes-compose-to"
				>
					{ __( 'To (node)', 'newspack-nodes' ) }
					<select
						id="nodes-compose-to"
						className="topology-modal__input"
						value={ to }
						onChange={ ( e ) => setTo( e.target.value ) }
					>
						{ nodeNames.map( ( n ) => (
							<option key={ n } value={ n }>
								{ n }
							</option>
						) ) }
					</select>
				</label>
				<label
					className="topology-modal__label"
					htmlFor="nodes-compose-type"
				>
					{ __( 'Type', 'newspack-nodes' ) }
					<select
						id="nodes-compose-type"
						className="topology-modal__input"
						value={ typeIdx }
						onChange={ ( e ) =>
							setTypeIdx( Number( e.target.value ) )
						}
					>
						{ COMPOSE_TYPES.map( ( [ label ], i ) => (
							<option key={ label } value={ i }>
								{ label }
							</option>
						) ) }
					</select>
				</label>
				{ takesValue && (
					<label
						className="topology-modal__label"
						htmlFor="nodes-compose-value"
					>
						{ __( 'Value', 'newspack-nodes' ) }
						<textarea
							id="nodes-compose-value"
							className="topology-modal__input"
							value={ value }
							onChange={ ( e ) => setValue( e.target.value ) }
							rows={ 8 }
						/>
					</label>
				) }
			</div>
			<div className="topology-modal__actions">
				<button
					type="button"
					className="topology-modal__btn"
					onClick={ onCancel }
				>
					{ __( 'Cancel', 'newspack-nodes' ) }
				</button>
				<button
					type="button"
					className="topology-modal__btn topology-modal__btn--primary"
					disabled={ ! to }
					onClick={ () => onConfirm( action, to, value ) }
				>
					{ __( 'Send', 'newspack-nodes' ) }
				</button>
			</div>
		</ModalShell>
	);
}

export default function Inspector( {
	selectedId,
	parsed,
	streamStatus,
	rateInfo,
	rateSeries,
	onAction,
	onSelect,
	onHover,
	nodeIds,
	editMode = false,
	catalog = [],
	formatters = [],
	onUpdateArgs,
	onUpdateVerbs,
	onRemoveNode,
	onRenameNode,
	onRemoveEdge,
	onConnect,
} ) {
	// Pending `send_node` payload prompt (replaces window.prompt).
	// Which value-taking verb's prompt modal is open (send/tell/send_struct), or
	// null. One shared PromptModal keyed by PROMPT_VERBS.
	const [ promptVerb, setPromptVerb ] = useState( null );
	// Whether the "Register a listener" modal is open.
	const [ registerOpen, setRegisterOpen ] = useState( false );
	// Whether the no-node message-composer (roadmap [46]) is open.
	const [ composeOpen, setComposeOpen ] = useState( false );

	if ( ! selectedId ) {
		// Edit mode has no live interpreter — the `_command_interpreter` header +
		// server-command palette below are meaningless for an offline draft. Show a
		// hint until a node is selected (selected nodes render the edit form).
		if ( editMode ) {
			return (
				<aside className="topology-inspector">
					<div className="topology-insp__empty">
						{ __(
							'Select a node to edit it, or drop one from the palette.',
							'newspack-nodes'
						) }
					</div>
				</aside>
			);
		}
		const node = parsed.nodes[ 0 ];
		const traceOn = node ? node.debugState > 0 : false;
		const live = ! streamStatus || streamStatus === 'open';
		return (
			<aside className="topology-inspector">
				<h2 className="topology-insp__title">_command_interpreter</h2>
				<div className="topology-insp__type">
					<span
						className={ `topology-insp__led${
							live ? ' is-pulsing' : ''
						}` }
					/>
					Command_Interpreter ·{ ' ' }
					{ live
						? __( 'LIVE', 'newspack-nodes' )
						: streamStatus.toUpperCase() }
				</div>
				<ProcessStatsHeader
					nodes={ parsed.nodes }
					rateSeries={ rateSeries }
				/>
				<div
					className="topology-insp__commands"
					data-testid="inspector-commands"
				>
					{ NO_NODE_COMMANDS.map( ( [ label, cmd ] ) => (
						<button
							key={ cmd }
							type="button"
							className={
								label === 'trace' && traceOn ? ' is-active' : ''
							}
							onClick={ () =>
								onAction && onAction( 'command', null, cmd )
							}
						>
							{ label }
						</button>
					) ) }
					<button
						type="button"
						onClick={ () => setComposeOpen( true ) }
						title={ __(
							'Compose a message — pick a target, type, and value (full CLI equivalence)',
							'newspack-nodes'
						) }
					>
						{ __( 'Compose', 'newspack-nodes' ) }
					</button>
				</div>
				{ composeOpen && (
					<ComposeModal
						nodeNames={ parsed.nodes.map( ( n ) => n.id ) }
						onConfirm={ ( action, to, value ) => {
							setComposeOpen( false );
							if ( onAction ) {
								onAction( action, to, value );
							}
						} }
						onCancel={ () => setComposeOpen( false ) }
					/>
				) }
			</aside>
		);
	}

	const node = parsed.nodes.find( ( n ) => n.id === selectedId );
	if ( ! node ) {
		return (
			<aside className="topology-inspector">
				<div className="topology-insp__empty">
					{ sprintf(
						// translators: %s: the node id that is no longer present.
						__( '%s no longer present', 'newspack-nodes' ),
						selectedId
					) }
				</div>
			</aside>
		);
	}

	if ( editMode ) {
		return (
			<EditForm
				node={ node }
				catalog={ catalog }
				formatters={ formatters }
				parsed={ parsed }
				onUpdateArgs={ onUpdateArgs }
				onUpdateVerbs={ onUpdateVerbs }
				onRemoveNode={ onRemoveNode }
				onRenameNode={ onRenameNode }
				onRemoveEdge={ onRemoveEdge }
				onConnect={ onConnect }
			/>
		);
	}

	const targets = parsed.edges.filter( ( e ) => e.from === selectedId );
	// Other live nodes, for the "+ add target…" dropdown (mirrors EditForm).
	const nodeNames = parsed.nodes
		.map( ( n ) => n.id )
		.filter( ( id ) => id !== selectedId );
	// The selected node's valid registration events (from the class catalog) —
	// drives the Register button + modal (roadmap [48]-C).
	const catalogEntry = catalog.find( ( c ) => c.shell_name === node.class );
	const regEvents = catalogEntry?.registrations ?? [];
	// The live editor uses the node's FULL uncollapsed target list — NOT
	// parsed.edges, which are headOf-collapsed (so `_sse/workers` → `_sse`, and a
	// disconnect would miss) and include registration edges that must get no ×.
	const editorTargets = ( node.targets || [] ).map( ( to ) => ( {
		from: selectedId,
		to,
	} ) );
	const type = node.class;
	// The tail/tap button keys off the catalog is_tee flag, so any Tee subclass
	// gets it regardless of the runtime target shape.
	const isTee = isTeeNode( node, catalog );
	// A consumer carries its read surface (frames + cursor) in dump_metadata.
	const isConsumer = isConsumerNode( node );
	// Absent streamStatus = no SSE stream to report (the debug overlay reads
	// the page's OWN Core synchronously, so the graph is literally always live).
	const live = ! streamStatus || streamStatus === 'open';

	// Button state derived from server metadata, not client bookkeeping.
	const traceOn = node.debugState > 0;
	// A tail (`connect_node <node>` with no target) defaults the Tee target to
	// the issuing command's FROM — THIS session's reply pivot. The metadata
	// producer reports that exact pivot as `parsed.pwd` (the reverse_cwd), so the
	// toggle is a precise match against the node's FULL targets — no reconstructing
	// the runtime-renamed path, and it works for the worker pivot AND the in-browser
	// JS tee (where pwd is the bare `_output`). parseMetadata collapses every edge
	// to its head, flattening all sessions' pivots to one shared `_repl`, so the
	// full target list is the only place the per-session pivot survives.
	const tailOn =
		!! parsed.pwd && ( node.targets || [] ).includes( parsed.pwd );
	// Read-only Constructor view: the class's declared positional args paired
	// with the values the node was GIVEN. An omitted optional arg falls back to
	// the schema default (shown dimmed). To change them, delete + recreate the
	// node — there is no live re-arg.
	const argSpecs =
		catalog.find( ( c ) => c.shell_name === node.class )?.arguments || [];
	const argValues = positionalArgs( node.arguments, argSpecs.length );

	return (
		<aside className="topology-inspector">
			<h2 className="topology-insp__title">{ node.id }</h2>
			<div className="topology-insp__type">
				<span
					className={ `topology-insp__led${
						live ? ' is-pulsing' : ''
					}` }
				/>
				{ type } ·{ ' ' }
				{ live
					? __( 'LIVE', 'newspack-nodes' )
					: streamStatus.toUpperCase() }
			</div>

			{ nodeHasTarget( node, catalog ) && (
				<Section title={ __( 'Routing', 'newspack-nodes' ) }>
					{ onConnect && onRemoveEdge && ! isReserved( node ) ? (
						// Live targets editor — the same UI as edit mode, but its
						// add/remove dispatch runtime connect_node/disconnect_node
						// (no .tsl write). Read-only fallback for reserved nodes /
						// when no handlers are wired.
						<TargetsField
							node={ node }
							nodeNames={ nodeNames }
							catalog={ catalog }
							targets={ editorTargets }
							onConnect={ onConnect }
							onRemoveEdge={ onRemoveEdge }
						/>
					) : (
						<>
							<div className="topology-field-row">
								<span className="topology-field-row__key">
									target →
								</span>
								<NodeLinks
									names={ targets
										.slice( 0, 1 )
										.map( ( t ) => t.to ) }
									nodeIds={ nodeIds }
									onSelect={ onSelect }
									onHover={ onHover }
								/>
							</div>
							{ targets.length > 1 && (
								<div className="topology-field-row">
									<span className="topology-field-row__key">
										also →
									</span>
									<NodeLinks
										names={ targets
											.slice( 1 )
											.map( ( t ) => t.to ) }
										nodeIds={ nodeIds }
										onSelect={ onSelect }
										onHover={ onHover }
									/>
								</div>
							) }
						</>
					) }
					{ /* sink + from dropped — substrate plumbing, no edit-mode equivalent. */ }
				</Section>
			) }

			{ ! isReserved( node ) && argSpecs.length > 0 && (
				<Section title={ __( 'Constructor', 'newspack-nodes' ) }>
					{ argSpecs.map( ( spec, i ) => {
						const passed = argValues[ i ];
						const hasPassed = undefined !== passed && '' !== passed;
						let shown = '—';
						if ( hasPassed ) {
							shown = passed;
						} else if ( undefined !== spec.default ) {
							shown = String( spec.default );
						}
						return (
							<div
								className="topology-insp__arg"
								key={ spec.name }
							>
								<span className="topology-insp__arg-name">
									{ spec.name }
									{ spec.required ? ' *' : '' }
								</span>
								<span
									className={ `topology-insp__arg-val${
										hasPassed
											? ''
											: ' topology-insp__arg-val--default'
									}` }
								>
									{ shown }
								</span>
							</div>
						);
					} ) }
				</Section>
			) }

			{ ( rateInfo?.hasMessages ||
				rateInfo?.hasRead ||
				rateInfo?.hasWritten ) && (
				<Section
					title={ __( 'Activity', 'newspack-nodes' ) }
					meta={ formatActivityWindow( parsed.nodes.length ) }
				>
					{ rateInfo.hasMessages && (
						<SparklineRow
							label={ __( 'messages /s', 'newspack-nodes' ) }
							history={ rateInfo.history }
							currentValue={ rateInfo.rate || 0 }
							format={ formatRate }
						/>
					) }
					{ rateInfo.hasRead && (
						<SparklineRow
							label={ __( 'bytes read /s', 'newspack-nodes' ) }
							history={ rateInfo.readHistory }
							currentValue={ rateInfo.readRate || 0 }
							format={ formatByteRate }
						/>
					) }
					{ rateInfo.hasWritten && (
						<SparklineRow
							label={ __( 'bytes written /s', 'newspack-nodes' ) }
							history={ rateInfo.writtenHistory }
							currentValue={ rateInfo.writtenRate || 0 }
							format={ formatByteRate }
						/>
					) }
				</Section>
			) }

			<Section
				title={ __( 'Throughput', 'newspack-nodes' ) }
				meta={ __( 'cumulative', 'newspack-nodes' ) }
			>
				<FieldRow
					k="counter"
					v={
						node.count !== undefined
							? node.count.toLocaleString()
							: '—'
					}
					vClass="topology-field-row__val--num"
				/>
				<FieldRow
					k="rate"
					v={ formatRate( rateInfo?.rate ) }
					vClass={
						rateInfo && rateInfo.rate > 0
							? 'topology-field-row__val--num'
							: 'topology-field-row__val--num topology-field-row__val--dim'
					}
				/>
				<FieldRow
					k="lgst_msg"
					v={ formatBytes( node.lgstMsg || 0 ) }
					vClass={
						node.lgstMsg
							? 'topology-field-row__val--num'
							: 'topology-field-row__val--num topology-field-row__val--dim'
					}
				/>
				<FieldRow
					k="read"
					v={ formatBytes( node.bytesRead || 0 ) }
					vClass={
						node.bytesRead
							? 'topology-field-row__val--num'
							: 'topology-field-row__val--num topology-field-row__val--dim'
					}
				/>
				<FieldRow
					k="written"
					v={ formatBytes( node.bytesWritten || 0 ) }
					vClass={
						node.bytesWritten
							? 'topology-field-row__val--num'
							: 'topology-field-row__val--num topology-field-row__val--dim'
					}
				/>
				<FieldRow
					k="last_seen"
					v={ formatLastSeen( rateInfo?.lastChangedTs, live ) }
					vClass={
						rateInfo && rateInfo.rate > 0
							? 'topology-field-row__val--right'
							: 'topology-field-row__val--right topology-field-row__val--dim'
					}
				/>
			</Section>

			{ isConsumer && (
				<Section title={ __( 'Time Travel', 'newspack-nodes' ) }>
					<TimeTravelPanel
						frames={ node.frames }
						cursor={ node.cursor }
						paused={ 'PAUSED' === node.polling }
						atFrameSignal={ node.at_frame ?? null }
						onFrameSignal={ !! node.on_frame }
						onTransport={ ( verb, positional = '' ) =>
							onAction &&
							onAction( 'invoke', node.id, {
								verb,
								kind: 'command',
								positional,
								// SEEK_FRAME's schema arg is `segment_id`; bare
								// transport verbs (PAUSE/PLAY/STEP) take none.
								byName:
									'SEEK_FRAME' === verb
										? { segment_id: positional }
										: {},
							} )
						}
					/>
				</Section>
			) }

			<div className="topology-insp__actions">
				<button
					type="button"
					onClick={ () => onAction && onAction( 'dump', node.id ) }
					title={ __(
						'Send `dump_node <name>` to the worker',
						'newspack-nodes'
					) }
				>
					{ __( 'Dump', 'newspack-nodes' ) }
				</button>
				<button
					type="button"
					onClick={ () =>
						onAction && onAction( 'dump_config', node.id )
					}
					title={ __(
						"Send `dump_config <name>` — the node's make_node config line",
						'newspack-nodes'
					) }
				>
					{ __( 'Config', 'newspack-nodes' ) }
				</button>
				<button
					type="button"
					onClick={ () => setPromptVerb( 'send' ) }
					title={ __(
						'Send a TM_BYTESTREAM payload to this node via `send_node <name> <bytes>`',
						'newspack-nodes'
					) }
				>
					{ __( 'Send', 'newspack-nodes' ) }
				</button>
				<button
					type="button"
					onClick={ () => onAction && onAction( 'request', node.id ) }
					title={ __(
						'Request a reply — `request_node <name>` (TM_REQUEST)',
						'newspack-nodes'
					) }
				>
					{ __( 'Request', 'newspack-nodes' ) }
				</button>
				<button
					type="button"
					onClick={ () => setPromptVerb( 'tell' ) }
					title={ __(
						'Send a TM_INFO payload — `tell_node <name> <info>`',
						'newspack-nodes'
					) }
				>
					{ __( 'Tell', 'newspack-nodes' ) }
				</button>
				<button
					type="button"
					onClick={ () => setPromptVerb( 'send_struct' ) }
					title={ __(
						'Send a TM_STRUCT JSON payload — `send_struct <name> <json>`',
						'newspack-nodes'
					) }
				>
					{ __( 'Struct', 'newspack-nodes' ) }
				</button>
				<button
					type="button"
					onClick={ () =>
						onAction && onAction( 'send_eof', node.id )
					}
					title={ __(
						'Send end-of-stream — `send_eof <name>` (TM_EOF)',
						'newspack-nodes'
					) }
				>
					{ __( 'EOF', 'newspack-nodes' ) }
				</button>
				{ regEvents.length > 0 && (
					<button
						type="button"
						onClick={ () => setRegisterOpen( true ) }
						title={ __(
							'Register a listener for one of this node’s events — `register <source> <target> <event>`',
							'newspack-nodes'
						) }
					>
						{ __( 'Register', 'newspack-nodes' ) }
					</button>
				) }
				<button
					type="button"
					className={ traceOn ? ' is-active' : '' }
					onClick={ () =>
						onAction &&
						onAction( 'trace', node.id, traceOn ? 0 : 1 )
					}
					title={
						traceOn
							? __(
									'Stop tracing — `debug_state <name> 0`',
									'newspack-nodes'
							  )
							: __(
									'Start tracing — `debug_state <name> 1`',
									'newspack-nodes'
							  )
					}
				>
					{ traceOn
						? __( 'Stop Trace', 'newspack-nodes' )
						: __( 'Trace', 'newspack-nodes' ) }
				</button>
				{ isTee && (
					<button
						type="button"
						className={ `topology-insp__actions-full${
							tailOn ? ' is-active' : ''
						}` }
						onClick={ () =>
							onAction &&
							onAction( tailOn ? 'disconnect' : 'tail', node.id )
						}
						title={
							tailOn
								? __(
										'Disconnect this session from the Tee — `disconnect_node <name>`',
										'newspack-nodes'
								  )
								: __(
										'Connect this session to the Tee — `connect_node <name>` (its output then flows into the transcript)',
										'newspack-nodes'
								  )
						}
					>
						{ tailOn
							? __( 'Disconnect', 'newspack-nodes' )
							: __( 'Connect', 'newspack-nodes' ) }
					</button>
				) }
				{ /* TM_COMMAND verbs + TM_REQUEST verbs from this class's node_schema. */ }
				{ /* Reserved spine nodes (e.g. _repl) skip these — the user doesn't own their configuration. */ }
				{ ! isReserved( node ) &&
					( () => {
						const schema = catalog.find(
							( c ) => c.shell_name === type
						);
						const commands = (
							schema && schema.commands ? schema.commands : []
						).filter( ( spec ) => ! spec.hidden );
						const requests =
							schema && schema.requests ? schema.requests : [];
						// node_name verb args pick from the live graph
						// (parsed = the dump_metadata snapshot), minus the
						// inspected node itself.
						const liveNodeNames = ( parsed?.nodes || [] )
							.map( ( n ) => n.name || n.id )
							.filter( ( n ) => n && n !== node.id );
						return [
							...commands.map( ( spec ) => (
								<VerbButton
									key={ `cmd-${ spec.name }` }
									nodeId={ node.id }
									spec={ spec }
									kind="command"
									formatters={ formatters }
									nodeNames={ liveNodeNames }
									onAction={ onAction }
								/>
							) ),
							...requests.map( ( spec ) => (
								<VerbButton
									key={ `req-${ spec.name }` }
									nodeId={ node.id }
									spec={ spec }
									kind="request"
									formatters={ formatters }
									nodeNames={ liveNodeNames }
									onAction={ onAction }
								/>
							) ),
						];
					} )() }
			</div>
			{ node.registrations &&
				Object.keys( node.registrations ).length > 0 && (
					<div className="topology-insp__listeners">
						<div className="topology-field-row__key">
							{ __( 'Listeners', 'newspack-nodes' ) }
						</div>
						{ Object.entries( node.registrations ).flatMap(
							( [ event, listeners ] ) =>
								( listeners || [] ).map( ( listener ) => (
									<div
										key={ `${ event }/${ listener }` }
										className="topology-insp__listener"
									>
										<span>
											{ event } → { listener }
										</span>
										<button
											type="button"
											className="topology-insp__listener-x"
											aria-label={ sprintf(
												// translators: %1$s: listener node; %2$s: event.
												__(
													'Unregister %1$s from %2$s',
													'newspack-nodes'
												),
												listener,
												event
											) }
											onClick={ () =>
												onAction &&
												onAction(
													'unregister',
													node.id,
													`${ listener } ${ event }`
												)
											}
										>
											×
										</button>
									</div>
								) )
						) }
					</div>
				) }
			{ promptVerb && (
				<PromptModal
					title={ sprintf(
						// translators: %s: payload noun (bytes / info / JSON).
						__( 'Send %s', 'newspack-nodes' ),
						PROMPT_VERBS[ promptVerb ].noun
					) }
					body={ sprintf(
						// translators: %1$s: payload noun; %2$s: the node id.
						__( 'Send %1$s to %2$s:', 'newspack-nodes' ),
						PROMPT_VERBS[ promptVerb ].noun,
						node.id
					) }
					confirmLabel={ PROMPT_VERBS[ promptVerb ].label }
					onConfirm={ ( payload ) => {
						const verb = promptVerb;
						setPromptVerb( null );
						if ( onAction ) {
							onAction( verb, node.id, payload );
						}
					} }
					onCancel={ () => setPromptVerb( null ) }
				/>
			) }
			{ registerOpen && (
				<RegisterModal
					source={ node.id }
					events={ regEvents }
					nodeNames={ nodeNames }
					onConfirm={ ( target, event ) => {
						setRegisterOpen( false );
						if ( onAction ) {
							onAction(
								'register',
								node.id,
								`${ target } ${ event }`
							);
						}
					} }
					onCancel={ () => setRegisterOpen( false ) }
				/>
			) }
		</aside>
	);
}
