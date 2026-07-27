/**
 * Right-pane inspector for the selected node.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { ModalShell, PromptModal } from './Modal';
import InspectorViewModal from './InspectorViewModal';
import { CtorField } from './CtorField';
import { tokenize } from '../../runtime/shell-node';
import IncludeTree from './IncludeTree';
import HullPanel from './HullPanel';
import TimeTravelPanel from './TimeTravelPanel';
import { FieldRow, Section } from './InspectorFields';
import {
	SparklineRow,
	ProcessStatsView,
	activityFromSeries,
	buildActivity,
	formatActivityWindow,
	formatBytes,
	formatByteRate,
	formatRate,
} from './ProcessStats';
import { processStats } from '../utils/processStats';
import { IoTelemetry } from '../../runtime/io-telemetry';
import { useNodeState } from '../../runtime/react';
import reservedNames from '../../runtime/reserved-node-names.json';
import { edgeHasConnectRole } from '../utils/draftGraph';
import { primaryButtonClass } from '@newspack-nodes/shared/utils/buttonClass';

// A Consumer/Tail node: its dump_metadata carries both `frames` and a `cursor`.
function isConsumerNode( node ) {
	return Array.isArray( node?.frames ) && !! node?.cursor;
}

// Hide config-edit affordances for the `_repl` anchor only (id + reserved).
function isReserved( node ) {
	return !! ( node && ( node.reserved || '_repl' === node.id ) );
}

// Borrowed via `include` — origin is a SET (a diamond-shared node has several).
function isBorrowed( node ) {
	return Array.isArray( node?.origin ) && node.origin.length > 0;
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

/**
 * Shared absorb-last core (positionalArgs is the string-input front door). parseTsl
 * whitespace-splits a `make_node`/`cmd` line's tail into a token array with no schema
 * knowledge, so a free-text arg with spaces (e.g. add_profile's `text`) arrives as many
 * tokens. Collapse the tail into the LAST declared slot so a one-arg verb binds the whole
 * value, not just the first token — and so serializeArg quotes it back into one
 * round-trippable token. Idempotent: an already-collapsed list (length <= count) is
 * returned unchanged, so applying it on edit-writeback never re-splits.
 *
 * @param {string[]} args  Token array from parseTsl (invocation.args / ctorArgs).
 * @param {number}   count Number of positional args the schema declares.
 * @return {string[]} Args of length <= count, last slot absorbing the tail.
 */
function absorbTrailingArgs( args, count ) {
	const list = Array.isArray( args ) ? args : [];
	if ( count <= 0 || list.length <= count ) {
		return list;
	}
	return [
		...list.slice( 0, count - 1 ),
		list.slice( count - 1 ).join( ' ' ),
	];
}

/**
 * Display form of a stored arg: the raw TSL span's VALUE — quote chars and
 * escapes are tokenizer syntax, not data, so they never leak into a field.
 * Storage keeps the span; an edited field writes back plain text, which the
 * serializer re-quotes safely.
 *
 * @param {*} token Stored arg (raw span, plain value, or nullish).
 * @return {*} The unwrapped display string; nullish passes through so
 *             CtorField still falls back to its schema default.
 */
function argDisplayValue( token ) {
	if ( token === undefined || token === null ) {
		return token;
	}
	return tokenize( String( token ) ).join( ' ' );
}

// Remote/worker scope: roll up dump_metadata via processStats + rate series.
function GraphProcessStats( { nodes, rateSeries } ) {
	const { messagesIn, messagesOut, bytesRead, bytesWritten } =
		processStats( nodes );
	const levels = useNodeState( reservedNames.DMESG, 'dmesg' ) || {
		errors: 0,
		warnings: 0,
		debug: 0,
	};
	return (
		<ProcessStatsView
			windowMeta={ formatActivityWindow( ( nodes || [] ).length ) }
			activity={ activityFromSeries( rateSeries ) }
			totals={ {
				msgsIn: messagesIn,
				msgsOut: messagesOut,
				bytesRead,
				bytesWritten,
			} }
			levels={ levels }
		/>
	);
}

// Human window label for the IoTelemetry rate ring's span (seconds).
function formatTelemetryWindow( span ) {
	if ( span >= 60 ) {
		return sprintf(
			// translators: %d: minutes of accumulated history.
			__( 'last ~%dm', 'newspack-nodes' ),
			Math.round( span / 60 )
		);
	}
	if ( span > 0 ) {
		return sprintf(
			// translators: %d: seconds of accumulated history.
			__( 'last ~%ds', 'newspack-nodes' ),
			span
		);
	}
	return __( 'live', 'newspack-nodes' );
}

// Browser scope: wire-accurate IoTelemetry counters (no graph double-count).
function BrowserProcessStats() {
	const [ , force ] = useState( 0 );
	useEffect(
		() => IoTelemetry.subscribe( () => force( ( n ) => n + 1 ) ),
		[]
	);
	const t = IoTelemetry.snapshot();
	const ring = IoTelemetry.getSeries();
	const col = ( i ) => ring.map( ( r ) => r[ i ] );
	const span =
		ring.length > 1
			? Math.round( ring[ ring.length - 1 ][ 0 ] - ring[ 0 ][ 0 ] )
			: 0;
	const windowMeta = formatTelemetryWindow( span );
	const msgIn = col( 1 );
	const msgOut = col( 2 );
	const byteIn = col( 3 );
	const byteOut = col( 4 );
	return (
		<ProcessStatsView
			windowMeta={ windowMeta }
			activity={ buildActivity( msgIn, msgOut, byteIn, byteOut ) }
			totals={ {
				msgsIn: t.msgsIn,
				msgsOut: t.msgsOut,
				bytesRead: t.bytesIn,
				bytesWritten: t.bytesOut,
			} }
			levels={ {
				errors: t.errors,
				warnings: t.warnings,
				debug: t.debug,
			} }
		/>
	);
}

// Browser graphs read own IoTelemetry; remote/worker roll up dump_metadata.
function ProcessStatsHeader( { nodes, rateSeries, local } ) {
	return local ? (
		<BrowserProcessStats />
	) : (
		<GraphProcessStats nodes={ nodes } rateSeries={ rateSeries } />
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

// Edit-mode form: schema-driven Constructor + Verbs for the draft node.

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
	vaults = [],
} ) {
	const checked = !! invocation;
	const id = `topology-verb-${ spec.name }`;
	// A `multiple` verb: one row per invocation (removable), not a checkbox.
	const showArgs =
		( multiple || checked ) &&
		invocation &&
		spec.args &&
		spec.args.length > 0;
	return (
		<div className="topology-edit-verb">
			{ multiple ? (
				<div className="topology-edit-row topology-edit-verb__head">
					<span
						className="topology-edit-row__label"
						title={ spec.description || undefined }
					>
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
					<span
						className="topology-edit-row__label"
						title={ spec.description || undefined }
					>
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
							value={ argDisplayValue( invocation.args[ i ] ) }
							nodeNames={ nodeNames }
							formatters={ formatters }
							vaults={ vaults }
							onChange={ ( v ) => onArgChange( i, v ) }
						/>
					) ) }
				</div>
			) }
		</div>
	);
}

// Live target wins, else catalog default, else true (mirrors OUT-port gating).
function nodeHasTarget( node, catalog ) {
	const schema = catalog.find( ( c ) => c.shell_name === node.class );
	return node.has_target ?? schema?.has_target ?? true;
}

// Fan-out per catalog fans_out; falls back to the runtime target shape.
function nodeFansOut( node, catalog ) {
	const schema = catalog.find( ( c ) => c.shell_name === node.class );
	return schema?.fans_out ?? Array.isArray( node.target );
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
	// A fan-out node (catalog fans_out) gets the multi-target editor.
	const fansOut = nodeFansOut( node, catalog );
	const datalistId = `topology-targets-${ node.id }`;
	if ( fansOut ) {
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
	// Physical edge only; virtual (verb-derived) edges live in Verbs section.
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

// Read-only verb args (borrowed nodes): disabled inputs mirroring the ctor row.
function LockedVerbArgs( { spec, invocation } ) {
	const argSpecs = spec.args || [];
	if ( ! invocation || argSpecs.length === 0 ) {
		return null;
	}
	return (
		<div className="topology-edit-verb__args">
			{ argSpecs.map( ( arg, i ) => (
				<input
					key={ arg.name }
					type="text"
					className="topology-edit-row__input"
					value={ argDisplayValue( invocation.args[ i ] ) ?? '' }
					disabled
					readOnly
				/>
			) ) }
		</div>
	);
}

// Single verb: a disabled checkbox, ticked when the borrowed node invokes it.
function LockedVerb( { spec, invocation } ) {
	return (
		<div className="topology-edit-verb">
			<div className="topology-edit-row">
				<input
					type="checkbox"
					checked={ !! invocation }
					disabled
					readOnly
					aria-label={ spec.name }
				/>
				<span
					className="topology-edit-row__label"
					title={ spec.description || undefined }
				>
					<code>{ spec.name }</code>
				</span>
			</div>
			<LockedVerbArgs spec={ spec } invocation={ invocation } />
		</div>
	);
}

// `multiple` verb: one read-only row per invocation (none renders nothing).
function LockedMultipleVerb( { spec, invocations } ) {
	return (
		<div className="topology-edit-verb-group">
			{ invocations.map( ( invocation, i ) => (
				<div className="topology-edit-verb" key={ i }>
					<div className="topology-edit-row topology-edit-verb__head">
						<span
							className="topology-edit-row__label"
							title={ spec.description || undefined }
						>
							<code>{ spec.name }</code>
						</span>
					</div>
					<LockedVerbArgs spec={ spec } invocation={ invocation } />
				</div>
			) ) }
		</div>
	);
}

// Borrowed node: config is immutable here — wiring stays editable on canvas.
function LockedForm( { node, catalog, tree, includes, onRemoveInclude } ) {
	const schema = catalog.find( ( c ) => c.shell_name === node.class ) || null;
	const argumentSpecs = schema?.arguments || [];
	const ctorArgs = absorbTrailingArgs(
		node.ctorArgs || [],
		argumentSpecs.length
	);
	// Read-only mirror of the edit Verbs list: same hidden filter, no editing.
	const commandSpecs = ( schema?.commands || [] ).filter(
		( spec ) => ! spec.hidden
	);
	const verbInvocations = ( node.verbInvocations || [] ).map( ( inv ) => {
		const cspec = ( schema?.commands || [] ).find(
			( c ) => c.name === inv.verb
		);
		return {
			...inv,
			args: absorbTrailingArgs( inv.args, ( cspec?.args || [] ).length ),
		};
	} );

	return (
		<aside className="topology-inspector">
			<h2 className="topology-insp__title">{ node.id }</h2>
			<div className="topology-insp__type">
				{ node.class || '?' } · { __( 'BORROWED', 'newspack-nodes' ) }
			</div>
			{ node.via?.length > 0 && (
				<div className="topology-insp__breadcrumb">
					via { node.via.join( ' → ' ) }
				</div>
			) }
			<Section title={ __( 'Constructor', 'newspack-nodes' ) }>
				{ argumentSpecs.length === 0 && (
					<div className="topology-edit-empty">
						{ __( 'No constructor arguments.', 'newspack-nodes' ) }
					</div>
				) }
				{ argumentSpecs.map( ( spec, i ) => (
					<div className="topology-edit-row" key={ spec.name }>
						<label
							htmlFor={ `topology-locked-ctor-${ spec.name }` }
							className="topology-edit-row__label"
						>
							{ spec.name }
						</label>
						<input
							id={ `topology-locked-ctor-${ spec.name }` }
							type="text"
							className="topology-edit-row__input"
							value={ argDisplayValue( ctorArgs[ i ] ) ?? '' }
							disabled
							readOnly
						/>
					</div>
				) ) }
			</Section>
			{ commandSpecs.length > 0 && (
				<Section title={ __( 'Verbs', 'newspack-nodes' ) }>
					{ commandSpecs.map( ( cspec ) =>
						cspec.multiple ? (
							<LockedMultipleVerb
								key={ cspec.name }
								spec={ cspec }
								invocations={ verbInvocations.filter(
									( inv ) => inv.verb === cspec.name
								) }
							/>
						) : (
							<LockedVerb
								key={ cspec.name }
								spec={ cspec }
								invocation={ verbInvocations.find(
									( inv ) => inv.verb === cspec.name
								) }
							/>
						)
					) }
				</Section>
			) }
			<IncludeTree
				tree={ tree }
				includes={ includes }
				selectedOrigin={ node.origin }
				onRemove={ onRemoveInclude }
			/>
		</aside>
	);
}

function EditForm( {
	node,
	catalog,
	formatters,
	vaults,
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
	// Drop hidden verbs (schema plumbing) from editor, matching the buttons.
	const commandSpecs = ( schema?.commands || [] ).filter(
		( spec ) => ! spec.hidden
	);
	// Absorb each free-text trailing arg into its declared slot (normalized).
	const ctorArgs = absorbTrailingArgs(
		node.ctorArgs || [],
		argumentSpecs.length
	);
	const verbInvocations = ( node.verbInvocations || [] ).map( ( inv ) => {
		const cspec = ( schema?.commands || [] ).find(
			( c ) => c.name === inv.verb
		);
		return {
			...inv,
			args: absorbTrailingArgs( inv.args, ( cspec?.args || [] ).length ),
		};
	} );
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
							( e ) =>
								e.from === node.id && edgeHasConnectRole( e )
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
							value={ argDisplayValue( ctorArgs[ i ] ) }
							nodeNames={ nodeNames }
							formatters={ formatters }
							vaults={ vaults }
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
						// `multiple` verb: row per call + Add, not checkbox.
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
											vaults={ vaults }
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
								vaults={ vaults }
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

// Modal collecting a verb's args (CtorField widgets), then fires 'invoke'.
function VerbArgModal( {
	nodeId,
	verb,
	kind,
	args,
	formatters,
	vaults,
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
						vaults={ vaults }
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
				<button type="button" className="button" onClick={ onDismiss }>
					{ __( 'Cancel', 'newspack-nodes' ) }
				</button>
				<button
					type="button"
					className={ primaryButtonClass( missingRequired ) }
					onClick={ run }
					disabled={ missingRequired }
				>
					{ __( 'Run', 'newspack-nodes' ) }
				</button>
			</div>
		</ModalShell>
	);
}

// One schema verb button; argless fire now, args open VerbArgModal.
function VerbButton( {
	nodeId,
	spec,
	kind,
	formatters,
	vaults,
	nodeNames,
	onAction,
} ) {
	const [ open, setOpen ] = useState( false );
	const hasArgs = spec.args && spec.args.length > 0;
	const verbLabel =
		'request' === kind ? `TM_REQUEST ${ spec.name }` : spec.name;
	return (
		<>
			<button
				type="button"
				className="button is-compact topology-insp__actions-full"
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
						// translators: %s: verb name (TM_REQUEST-prefixed for request verbs).
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
					vaults={ vaults }
					nodeNames={ nodeNames }
					onAction={ onAction }
					onDismiss={ () => setOpen( false ) }
				/>
			) }
		</>
	);
}

// Value-taking node verbs: each opens ONE shared prompt modal keyed by verb.
const PROMPT_VERBS = {
	cmd: { label: 'Command', noun: 'phrase' },
	send: { label: 'Send', noun: 'bytes' },
	request: { label: 'Request', noun: 'payload' },
	tell: { label: 'Tell', noun: 'info' },
	send_struct: { label: 'Struct', noun: 'JSON' },
};

// COMMANDS group: stateless [label, verb] transcript-dumps.
const NO_NODE_COMMANDS = [
	[ 'dmesg', 'dmesg' ],
	[ 'config', 'dump_config' ],
	[ 'metadata', 'dump_metadata' ],
	[ 'stats', 'stats' ],
	[ 'timers', 'list_timers' ],
	[ 'handles', 'list_handles' ],
	[ 'profiles', 'list_profiles' ],
	[ 'ping', 'ping' ],
];

// Register modal: wire a listener to a source node's registration event.
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
				<button type="button" className="button" onClick={ onCancel }>
					{ __( 'Cancel', 'newspack-nodes' ) }
				</button>
				<button
					type="button"
					className={ primaryButtonClass( ! event || ! target ) }
					disabled={ ! event || ! target }
					onClick={ () => onConfirm( target, event ) }
				>
					{ __( 'Register', 'newspack-nodes' ) }
				</button>
			</div>
		</ModalShell>
	);
}

// Message-composer types: each maps to a CLI verb. [label, action, takesValue].
const COMPOSE_TYPES = [
	[ 'TM_COMMAND (command_node)', 'cmd', true ],
	[ 'TM_BYTESTREAM (send_node)', 'send', true ],
	[ 'TM_REQUEST (request_node)', 'request', true ],
	[ 'TM_INFO (tell_node)', 'tell', true ],
	[ 'TM_STRUCT (send_struct)', 'send_struct', true ],
	[ 'TM_EOF (send_eof)', 'send_eof', false ],
];

// Compose modal: pick target+TYPE+value → CLI verb; flags applied downstream.
function ComposeModal( { nodeNames, onConfirm, onCancel } ) {
	const [ to, setTo ] = useState( nodeNames[ 0 ] || '' );
	const [ typeIdx, setTypeIdx ] = useState( 0 );
	const [ value, setValue ] = useState( '' );
	const [ responseFlag, setResponseFlag ] = useState( false );
	const [ errorFlag, setErrorFlag ] = useState( false );
	// Blank = keep what the mint stamped (FROM: this session's reply path).
	const [ from, setFrom ] = useState( '' );
	const [ id, setId ] = useState( '' );
	const [ key, setKey ] = useState( '' );
	const [ timestamp, setTimestamp ] = useState( '' );
	const [ , action, takesValue ] = COMPOSE_TYPES[ typeIdx ];
	return (
		<ModalShell
			title={ __( 'Compose a message', 'newspack-nodes' ) }
			onDismiss={ onCancel }
		>
			<div className="topology-modal__body">
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
				<div className="topology-modal__checkbox-row">
					<label
						className="topology-modal__label topology-modal__label--checkbox"
						htmlFor="nodes-compose-response"
					>
						<input
							id="nodes-compose-response"
							type="checkbox"
							checked={ responseFlag }
							onChange={ ( e ) =>
								setResponseFlag( e.target.checked )
							}
						/>
						{ __( 'TM_RESPONSE', 'newspack-nodes' ) }
					</label>
					<label
						className="topology-modal__label topology-modal__label--checkbox"
						htmlFor="nodes-compose-error"
					>
						<input
							id="nodes-compose-error"
							type="checkbox"
							checked={ errorFlag }
							onChange={ ( e ) =>
								setErrorFlag( e.target.checked )
							}
						/>
						{ __( 'TM_ERROR', 'newspack-nodes' ) }
					</label>
				</div>
				<label
					className="topology-modal__label"
					htmlFor="nodes-compose-timestamp"
				>
					{ __( 'Timestamp', 'newspack-nodes' ) }
					<input
						id="nodes-compose-timestamp"
						className="topology-modal__input"
						type="text"
						value={ timestamp }
						placeholder={ __( 'now (default)', 'newspack-nodes' ) }
						onChange={ ( e ) => setTimestamp( e.target.value ) }
					/>
				</label>
				<label
					className="topology-modal__label"
					htmlFor="nodes-compose-from"
				>
					{ __( 'From (reply path)', 'newspack-nodes' ) }
					<input
						id="nodes-compose-from"
						className="topology-modal__input"
						type="text"
						value={ from }
						placeholder={ __(
							'this session (default)',
							'newspack-nodes'
						) }
						onChange={ ( e ) => setFrom( e.target.value ) }
					/>
				</label>
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
					htmlFor="nodes-compose-id"
				>
					{ __( 'ID', 'newspack-nodes' ) }
					<input
						id="nodes-compose-id"
						className="topology-modal__input"
						type="text"
						value={ id }
						onChange={ ( e ) => setId( e.target.value ) }
					/>
				</label>
				<label
					className="topology-modal__label"
					htmlFor="nodes-compose-key"
				>
					{ __( 'Key', 'newspack-nodes' ) }
					<input
						id="nodes-compose-key"
						className="topology-modal__input"
						type="text"
						value={ key }
						onChange={ ( e ) => setKey( e.target.value ) }
					/>
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
				<button type="button" className="button" onClick={ onCancel }>
					{ __( 'Cancel', 'newspack-nodes' ) }
				</button>
				<button
					type="button"
					className={ primaryButtonClass( ! to ) }
					disabled={ ! to }
					onClick={ () =>
						onConfirm( action, to, value, {
							response: responseFlag,
							error: errorFlag,
							from,
							id,
							key,
							timestamp,
						} )
					}
				>
					{ __( 'Send', 'newspack-nodes' ) }
				</button>
			</div>
		</ModalShell>
	);
}

export default function Inspector( {
	selectedId,
	selectedHull = null,
	hulls = [],
	onOpenTopology,
	parsed,
	streamStatus,
	rateInfo,
	rateSeries,
	hullRateSeries,
	local = false,
	debugLevel = 0,
	onAction,
	onSelect,
	onHover,
	nodeIds,
	editMode = false,
	catalog = [],
	formatters = [],
	vaults = [],
	onUpdateArgs,
	onUpdateVerbs,
	onRemoveNode,
	onRenameNode,
	onRemoveEdge,
	onConnect,
	composeTargets,
	tree = {},
	includes = [],
	onRemoveInclude,
} ) {
	// Which value-taking verb's prompt modal is open, or null (shared modal).
	const [ promptVerb, setPromptVerb ] = useState( null );
	// Whether the "Register a listener" modal is open.
	const [ registerOpen, setRegisterOpen ] = useState( false );
	// Whether the no-node message-composer (roadmap [46]) is open.
	const [ composeOpen, setComposeOpen ] = useState( false );
	// Which no-node modal view is open, or null when closed.
	const [ stripModal, setStripModal ] = useState( null );
	// Whether the selected node's dead-letter Triage modal is open.
	const [ triageOpen, setTriageOpen ] = useState( false );
	// Toggle override: agreement clears; one stale reply tolerated; two fail.
	const [ profilingOptimistic, setProfilingOptimistic ] = useState( null );
	const profilingDisagreeRef = useRef( 0 );
	useEffect( () => {
		if ( null === profilingOptimistic ) {
			return;
		}
		const agrees = !! parsed?.profiling === profilingOptimistic;
		if ( agrees || profilingDisagreeRef.current >= 1 ) {
			profilingDisagreeRef.current = 0;
			setProfilingOptimistic( null );
			return;
		}
		profilingDisagreeRef.current += 1;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ parsed ] );

	// A hull gets its own panel; a node selection still wins over it.
	if ( ! selectedId && selectedHull ) {
		return (
			<HullPanel
				include={ selectedHull }
				hulls={ hulls }
				parsed={ parsed }
				rateSeries={ hullRateSeries }
				editMode={ editMode }
				includeTree={ tree }
				onOpenTopology={ onOpenTopology }
				onRemoveInclude={ onRemoveInclude }
			/>
		);
	}

	if ( ! selectedId ) {
		// Edit mode has no live interpreter; hint until a node is selected.
		if ( editMode ) {
			return (
				<aside className="topology-inspector">
					<div className="topology-insp__empty">
						{ __(
							'Select a node to edit it, or drop one from the palette.',
							'newspack-nodes'
						) }
					</div>
					<IncludeTree
						tree={ tree }
						includes={ includes }
						selectedOrigin={ null }
						onRemove={ onRemoveInclude }
					/>
				</aside>
			);
		}
		// The button toggles EVERY node; any traced node reads as tracing.
		const traceOn = parsed.nodes.some( ( n ) => n.debugState > 0 );
		// Profiling: optimistic override until the metadata poll reconciles.
		const profilingOn =
			null !== profilingOptimistic
				? profilingOptimistic
				: !! parsed.profiling;
		// One dial (debug_level): debug lit at >= 1, verbose at >= 2.
		const debugOn = ( debugLevel ?? 0 ) >= 1;
		const verboseOn = ( debugLevel ?? 0 ) >= 2;
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
					local={ local }
				/>
				<div data-testid="inspector-commands">
					{ /* VIEWS — buttons that open a modal (inspection panels +
					     the composer), never a command down the transcript. */ }
					<Section title={ __( 'Views', 'newspack-nodes' ) }>
						<div className="topology-insp__commands">
							<button
								type="button"
								className="button is-compact"
								onClick={ () => setStripModal( 'runtime' ) }
								title={ __(
									'Current-scope timers + handles as live sortable grids',
									'newspack-nodes'
								) }
							>
								{ __( 'Runtime', 'newspack-nodes' ) }
							</button>
							<button
								type="button"
								className="button is-compact"
								onClick={ () => setStripModal( 'stats' ) }
								title={ __(
									'Per-node throughput + Router profiling as a sortable grid',
									'newspack-nodes'
								) }
							>
								{ __( 'Profiler', 'newspack-nodes' ) }
							</button>
							<button
								type="button"
								className="button is-compact"
								onClick={ () => setStripModal( 'timeline' ) }
								title={ __(
									'DEBUG traces from the transcript as a filterable timeline',
									'newspack-nodes'
								) }
							>
								{ __( 'Timeline', 'newspack-nodes' ) }
							</button>
							<button
								type="button"
								className="button is-compact"
								onClick={ () => setComposeOpen( true ) }
								title={ __(
									'Compose a message — pick a target, type, and value (full CLI equivalence)',
									'newspack-nodes'
								) }
							>
								{ __( 'Compose', 'newspack-nodes' ) }
							</button>

							{ /* TOGGLES — stateful two-state buttons. Each flips
					     optimistically (label swap + is-active) and reconciles to
					     server truth: Trace + Profiling against the metadata poll,
					     Verbose against the live LOCAL debug_level. */ }
						</div>
					</Section>
					<Section title={ __( 'Toggles', 'newspack-nodes' ) }>
						<div className="topology-insp__commands">
							<button
								type="button"
								className={ `button is-compact${
									traceOn ? ' is-active' : ''
								}` }
								onClick={ () =>
									onAction &&
									onAction( 'trace', '*', traceOn ? 0 : 1 )
								}
								title={
									traceOn
										? __(
												'Stop tracing every node — `trace * 0`',
												'newspack-nodes'
										  )
										: __(
												'Trace every node — `trace * 1`',
												'newspack-nodes'
										  )
								}
							>
								{ traceOn
									? __( 'stop trace', 'newspack-nodes' )
									: __( 'trace', 'newspack-nodes' ) }
							</button>
							<button
								type="button"
								className={ `button is-compact${
									profilingOn ? ' is-active' : ''
								}` }
								onClick={ () => {
									profilingDisagreeRef.current = 0;
									setProfilingOptimistic( ! profilingOn );
									if ( onAction ) {
										onAction(
											'command',
											null,
											profilingOn
												? 'profile off'
												: 'profile on'
										);
									}
								} }
								title={
									profilingOn
										? __(
												'Stop _router profiling — `profile off`',
												'newspack-nodes'
										  )
										: __(
												'Profile every _router dispatch — `profile on`',
												'newspack-nodes'
										  )
								}
							>
								{ profilingOn
									? __( 'stop profiling', 'newspack-nodes' )
									: __( 'profile', 'newspack-nodes' ) }
							</button>
							<button
								type="button"
								className={ `button is-compact${
									debugOn ? ' is-active' : ''
								}` }
								onClick={ () =>
									onAction &&
									onAction(
										'command',
										null,
										debugOn
											? 'debug_level 0'
											: 'debug_level 1'
									)
								}
								title={
									debugOn
										? __(
												'Quiet the Dumper — `debug_level 0`',
												'newspack-nodes'
										  )
										: __(
												'Per-message Dumper header — `debug_level 1`',
												'newspack-nodes'
										  )
								}
							>
								{ debugOn
									? __( 'stop debug', 'newspack-nodes' )
									: __( 'debug', 'newspack-nodes' ) }
							</button>
							<button
								type="button"
								className={ `button is-compact${
									verboseOn ? ' is-active' : ''
								}` }
								onClick={ () =>
									onAction &&
									onAction(
										'command',
										null,
										verboseOn
											? 'debug_level 0'
											: 'debug_level 2'
									)
								}
								title={
									verboseOn
										? __(
												'Quiet the Dumper — `debug_level 0`',
												'newspack-nodes'
										  )
										: __(
												'Verbose Dumper trace — `debug_level 2`',
												'newspack-nodes'
										  )
								}
							>
								{ verboseOn
									? __( 'stop verbose', 'newspack-nodes' )
									: __( 'verbose', 'newspack-nodes' ) }
							</button>
						</div>
					</Section>
					{ /* COMMANDS — stateless verb dumps into the transcript. */ }
					<Section title={ __( 'Commands', 'newspack-nodes' ) }>
						<div className="topology-insp__commands">
							{ NO_NODE_COMMANDS.map( ( [ label, cmd ] ) => (
								<button
									key={ cmd }
									type="button"
									className="button is-compact"
									onClick={ () =>
										onAction &&
										onAction( 'command', null, cmd )
									}
								>
									{ label }
								</button>
							) ) }
						</div>
					</Section>
				</div>
				{ composeOpen && (
					<ComposeModal
						nodeNames={
							composeTargets ?? parsed.nodes.map( ( n ) => n.id )
						}
						onConfirm={ ( action, to, value, flags ) => {
							setComposeOpen( false );
							if ( onAction ) {
								onAction( action, to, value, flags );
							}
						} }
						onCancel={ () => setComposeOpen( false ) }
					/>
				) }
				{ stripModal && (
					<InspectorViewModal
						view={ stripModal }
						onDismiss={ () => setStripModal( null ) }
						onAction={ onAction }
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
		if ( isBorrowed( node ) ) {
			return (
				<LockedForm
					node={ node }
					catalog={ catalog }
					tree={ tree }
					includes={ includes }
					onRemoveInclude={ onRemoveInclude }
				/>
			);
		}
		return (
			<>
				<EditForm
					node={ node }
					catalog={ catalog }
					formatters={ formatters }
					vaults={ vaults }
					parsed={ parsed }
					onUpdateArgs={ onUpdateArgs }
					onUpdateVerbs={ onUpdateVerbs }
					onRemoveNode={ onRemoveNode }
					onRenameNode={ onRenameNode }
					onRemoveEdge={ onRemoveEdge }
					onConnect={ onConnect }
				/>
				<IncludeTree
					tree={ tree }
					includes={ includes }
					selectedOrigin={ null }
					onRemove={ onRemoveInclude }
				/>
			</>
		);
	}

	const targets = parsed.edges.filter( ( e ) => e.from === selectedId );
	// Other live nodes, for the "+ add target…" dropdown (mirrors EditForm).
	const nodeNames = parsed.nodes
		.map( ( n ) => n.id )
		.filter( ( id ) => id !== selectedId );
	// The node's valid registration events (catalog) — drives Register modal.
	const catalogEntry = catalog.find( ( c ) => c.shell_name === node.class );
	const regEvents = catalogEntry?.registrations ?? [];
	// Use the node's FULL uncollapsed targets (parsed.edges head-collapsed).
	const editorTargets = ( node.targets || [] ).map( ( to ) => ( {
		from: selectedId,
		to,
	} ) );
	const type = node.class;
	// The tail/tap button keys off the catalog fans_out flag.
	const fansOut = nodeFansOut( node, catalog );
	// A consumer carries its read surface (frames + cursor) in dump_metadata.
	const isConsumer = isConsumerNode( node );
	// No streamStatus = no SSE stream (overlay reads its own Core, live).
	const live = ! streamStatus || streamStatus === 'open';

	// Button state derived from server metadata, not client bookkeeping.
	const traceOn = node.debugState > 0;
	// A tail defaults to the session's reply FROM; match node's FULL targets.
	const tailOn =
		!! parsed.pwd && ( node.targets || [] ).includes( parsed.pwd );
	// Read-only Constructor: declared args + given values (no live re-arg).
	const argSpecs =
		catalog.find( ( c ) => c.shell_name === node.class )?.arguments || [];
	// node.arguments is a token array; absorb the tail into the last slot.
	const argValues = absorbTrailingArgs( node.arguments, argSpecs.length );
	// DLQ Triage: consumer-family node with a non-empty deadletter_dir arg.
	const deadletterIdx = argSpecs.findIndex(
		( s ) => 'deadletter_dir' === s.name
	);
	const deadletterDir =
		deadletterIdx >= 0 ? String( argValues[ deadletterIdx ] ?? '' ) : '';
	const hasDeadletterQueue = isConsumer && '' !== deadletterDir.trim();
	const deadletterSegments = node.deadletter_segments ?? 0;

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
						// Targets editor: add/remove dispatches connect_node.
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
								// SEEK_FRAME takes `segment`; others none.
								byName:
									'SEEK_FRAME' === verb
										? { segment: positional }
										: {},
							} )
						}
					/>
				</Section>
			) }

			{ hasDeadletterQueue && (
				<Section title={ __( 'Dead-Letter Queue', 'newspack-nodes' ) }>
					<button
						type="button"
						className="button is-compact topology-insp__actions-full"
						onClick={ () => setTriageOpen( true ) }
						title={ __(
							'Inspect, requeue, and purge this node’s quarantined records',
							'newspack-nodes'
						) }
					>
						{ deadletterSegments > 0
							? sprintf(
									// translators: %d: dead-letter segment count.
									__( 'Triage (%d)', 'newspack-nodes' ),
									deadletterSegments
							  )
							: __( 'Triage', 'newspack-nodes' ) }
					</button>
					{ 0 === deadletterSegments && (
						<span className="topology-edit-row__hint">
							{ __(
								'No quarantined records.',
								'newspack-nodes'
							) }
						</span>
					) }
				</Section>
			) }

			{ /* COMMANDS — stateless dumps into the transcript. */ }
			<Section title={ __( 'Commands', 'newspack-nodes' ) }>
				<div className="topology-insp__actions">
					<button
						type="button"
						className="button is-compact"
						onClick={ () =>
							onAction && onAction( 'dump', node.id )
						}
						title={ __(
							'Send `dump_node <name>` to the worker',
							'newspack-nodes'
						) }
					>
						{ __( 'Dump', 'newspack-nodes' ) }
					</button>
					<button
						type="button"
						className="button is-compact"
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
				</div>
			</Section>
			{ /* MESSAGES — mint a typed message at this node. */ }
			<Section title={ __( 'Messages', 'newspack-nodes' ) }>
				<div className="topology-insp__actions">
					<button
						type="button"
						className="button is-compact"
						onClick={ () => setPromptVerb( 'cmd' ) }
						title={ __(
							'Send a TM_COMMAND payload to this node via `command_node <name> <phrase>`',
							'newspack-nodes'
						) }
					>
						{ __( 'Command', 'newspack-nodes' ) }
					</button>
					<button
						type="button"
						className="button is-compact"
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
						className="button is-compact"
						onClick={ () => setPromptVerb( 'request' ) }
						title={ __(
							'Send a TM_REQUEST payload — `request_node <name> <payload>`',
							'newspack-nodes'
						) }
					>
						{ __( 'Request', 'newspack-nodes' ) }
					</button>
					<button
						type="button"
						className="button is-compact"
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
						className="button is-compact"
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
						className="button is-compact"
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
							className="button is-compact"
							onClick={ () => setRegisterOpen( true ) }
							title={ __(
								'Register a listener for one of this node’s events — `register <source> <target> <event>`',
								'newspack-nodes'
							) }
						>
							{ __( 'Register', 'newspack-nodes' ) }
						</button>
					) }
				</div>
			</Section>
			{ /* TOGGLES — stateful switches on this node. */ }
			<Section title={ __( 'Toggles', 'newspack-nodes' ) }>
				<div className="topology-insp__actions">
					<button
						type="button"
						className={ `button is-compact${
							traceOn ? ' is-active' : ''
						}` }
						onClick={ () =>
							onAction &&
							onAction( 'trace', node.id, traceOn ? 0 : 1 )
						}
						title={
							traceOn
								? __(
										'Stop tracing — `trace <name> 0`',
										'newspack-nodes'
								  )
								: __(
										'Start tracing — `trace <name> 1`',
										'newspack-nodes'
								  )
						}
					>
						{ traceOn
							? __( 'Stop Trace', 'newspack-nodes' )
							: __( 'Trace', 'newspack-nodes' ) }
					</button>
					{ fansOut && (
						<button
							type="button"
							className={ `button is-compact${
								tailOn ? ' is-active' : ''
							}` }
							onClick={ () =>
								onAction &&
								onAction(
									tailOn ? 'disconnect' : 'tail',
									node.id
								)
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
				</div>
			</Section>
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
					if ( ! commands.length && ! requests.length ) {
						return null;
					}
					// node_name args = live graph nodes minus inspected.
					const liveNodeNames = ( parsed?.nodes || [] )
						.map( ( n ) => n.name || n.id )
						.filter( ( n ) => n && n !== node.id );
					return (
						<Section title={ __( 'Verbs', 'newspack-nodes' ) }>
							<div className="topology-insp__actions">
								{ commands.map( ( spec ) => (
									<VerbButton
										key={ `cmd-${ spec.name }` }
										nodeId={ node.id }
										spec={ spec }
										kind="command"
										formatters={ formatters }
										vaults={ vaults }
										nodeNames={ liveNodeNames }
										onAction={ onAction }
									/>
								) ) }
								{ requests.map( ( spec ) => (
									<VerbButton
										key={ `req-${ spec.name }` }
										nodeId={ node.id }
										spec={ spec }
										kind="request"
										formatters={ formatters }
										vaults={ vaults }
										nodeNames={ liveNodeNames }
										onAction={ onAction }
									/>
								) ) }
							</div>
						</Section>
					);
				} )() }
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
			{ triageOpen && (
				<InspectorViewModal
					view="triage"
					node={ node }
					onDismiss={ () => setTriageOpen( false ) }
					onAction={ onAction }
				/>
			) }
		</aside>
	);
}
