/**
 * Right-pane inspector for the selected node.
 */

import { useEffect, useState } from '@wordpress/element';

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

// Inspector sparkline (wider/taller variant of the node-card one).
const INSP_SPARK_HISTORY_MAX = 60;
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
						peak { format( peak ) }
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

function formatLastSeen( ts, live ) {
	if ( ts === undefined || ts === null ) {
		return live ? 'streaming' : '—';
	}
	const ago = Date.now() / 1000 - ts;
	if ( ago < 1 ) {
		return 'just now';
	}
	if ( ago < 60 ) {
		return `${ ago.toFixed( 1 ) }s ago`;
	}
	if ( ago < 3600 ) {
		return `${ Math.round( ago / 60 ) }m ago`;
	}
	return `${ Math.round( ago / 3600 ) }h ago`;
}

// Edit-mode form: schema-driven Constructor + Verbs sections for the draft node.

function inputForType( type ) {
	switch ( type ) {
		case 'bool':
			// Text, not checkbox, so the field can hold a `<config:...>` token.
			return { type: 'text', placeholder: 'true | false | <config:...>' };
		// All types are text: substitution tokens are strings an
		// `input type="number"` would reject; loader coerces at runtime.
		case 'int':
			return { type: 'text', inputMode: 'numeric' };
		case 'float':
			return { type: 'text', inputMode: 'decimal' };
		default:
			return { type: 'text' };
	}
}

export function coerceValue( type, raw ) {
	if ( 'bool' === type ) {
		// Store strings as-is; normalize legacy JS booleans to "true"/"false".
		if ( 'boolean' === typeof raw ) {
			return raw ? 'true' : 'false';
		}
		return String( raw ?? '' );
	}
	if ( 'int' === type ) {
		if ( '' === raw ) {
			return '';
		}
		// Pure-integer strings → number; tokens/partial input pass through.
		return /^-?\d+$/.test( String( raw ).trim() )
			? parseInt( raw, 10 )
			: raw;
	}
	if ( 'float' === type ) {
		if ( '' === raw ) {
			return '';
		}
		return /^-?\d*\.?\d+(?:[eE][+-]?\d+)?$/.test( String( raw ).trim() )
			? parseFloat( raw )
			: raw;
	}
	return String( raw );
}

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
			return 'Name cannot be empty.';
		}
		if ( trimmed === node.id ) {
			return '';
		}
		if ( takenNames.has( trimmed ) ) {
			return `Name '${ trimmed }' already in use.`;
		}
		if ( ! /^[a-zA-Z0-9_:-]+$/.test( trimmed ) ) {
			return 'Letters, digits, dash, underscore, colon only.';
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
			setError( 'Rename refused — name already taken.' );
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

function CtorField( {
	spec,
	value,
	onChange,
	nodeNames = [],
	formatters = [],
} ) {
	const meta = inputForType( spec.type );
	const id = `topology-ctor-${ spec.name }`;
	if ( 'formatter_name' === spec.type ) {
		// Pick from registered formatters; empty list falls back to free text.
		if ( formatters.length === 0 ) {
			return (
				<div className="topology-edit-row">
					<label htmlFor={ id } className="topology-edit-row__label">
						{ spec.name }
						{ spec.required ? ' *' : '' }
					</label>
					<input
						id={ id }
						type="text"
						className="topology-edit-row__input"
						value={ value ?? '' }
						placeholder="(no formatters registered)"
						onChange={ ( e ) => onChange( e.target.value ) }
					/>
				</div>
			);
		}
		return (
			<div className="topology-edit-row">
				<label htmlFor={ id } className="topology-edit-row__label">
					{ spec.name }
					{ spec.required ? ' *' : '' }
				</label>
				<select
					id={ id }
					className="topology-edit-row__input"
					value={ value ?? '' }
					onChange={ ( e ) => onChange( e.target.value ) }
				>
					<option value="">(pick a formatter)</option>
					{ formatters.map( ( name ) => (
						<option key={ name } value={ name }>
							{ name }
						</option>
					) ) }
				</select>
			</div>
		);
	}
	if ( 'node_name' === spec.type ) {
		// node_name args define a logical edge synthesized onto the canvas.
		return (
			<div className="topology-edit-row">
				<label htmlFor={ id } className="topology-edit-row__label">
					{ spec.name }
					{ spec.required ? ' *' : '' }
				</label>
				<select
					id={ id }
					className="topology-edit-row__input"
					value={ value ?? '' }
					onChange={ ( e ) => onChange( e.target.value ) }
				>
					<option value="">(pick a node)</option>
					{ nodeNames.map( ( name ) => (
						<option key={ name } value={ name }>
							{ name }
						</option>
					) ) }
				</select>
			</div>
		);
	}
	// Normalize legacy JS-boolean bool args to "true"/"false" strings.
	const rawValue = value ?? spec.default ?? '';
	let currentValue = rawValue;
	if ( 'boolean' === typeof rawValue ) {
		currentValue = rawValue ? 'true' : 'false';
	}
	const hasContent = String( currentValue ).length > 0;
	return (
		<div className="topology-edit-row">
			<label htmlFor={ id } className="topology-edit-row__label">
				{ spec.name }
				{ spec.required ? ' *' : '' }
			</label>
			<div className="topology-edit-row__input-wrap">
				<input
					id={ id }
					type={ meta.type }
					inputMode={ meta.inputMode }
					step={ meta.step }
					className="topology-edit-row__input"
					value={ currentValue }
					placeholder={
						meta.placeholder ??
						( spec.default !== undefined
							? String( spec.default )
							: '' )
					}
					onChange={ ( e ) =>
						onChange( coerceValue( spec.type, e.target.value ) )
					}
				/>
				{ hasContent && (
					<button
						type="button"
						className="topology-edit-row__clear"
						aria-label={ `Clear ${ spec.name }` }
						onClick={ () => onChange( '' ) }
					>
						×
					</button>
				) }
			</div>
		</div>
	);
}

function VerbRow( {
	spec,
	invocation,
	onToggle,
	onArgChange,
	nodeNames = [],
	formatters = [],
} ) {
	const checked = !! invocation;
	const id = `topology-verb-${ spec.name }`;
	return (
		<div className="topology-edit-verb">
			{ /* eslint-disable-next-line jsx-a11y/label-has-associated-control -- the input IS the associated control (nested child); the rule's required-htmlFor pattern is also satisfied. */ }
			<label className="topology-edit-row" htmlFor={ id }>
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
			{ checked && spec.args && spec.args.length > 0 && (
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

// Tee fans out to many targets; everything else has a single target.
function TargetsField( { node, nodeNames, targets, onConnect, onRemoveEdge } ) {
	const isTee = node.class === 'Tee';
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
						<option value="">+ add target…</option>
						{ available.map( ( n ) => (
							<option key={ n } value={ n }>
								{ n }
							</option>
						) ) }
					</select>
				) }
				{ available.length === 0 && targets.length === 0 && (
					<span className="topology-edit-row__hint">
						No other nodes to wire to yet.
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
				<option value="">(none)</option>
				{ options.map( ( n ) => (
					<option key={ n } value={ n }>
						{ n }
					</option>
				) ) }
			</select>
			{ targets.some( ( e ) => e.virtual ) && (
				<span className="topology-edit-row__hint">
					Plus virtual edge(s) from verb args — manage in Verbs.
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
					aria-label={ `Remove ${ label }` }
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
	const ctorSpecs = schema?.ctor || [];
	const verbSpecs = schema?.verbs || [];
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
				{ node.class || '?' } · EDIT
			</div>

			{ onRemoveNode && (
				<button
					type="button"
					className="topology-edit-delete"
					onClick={ () => onRemoveNode( node.id ) }
				>
					Delete node
				</button>
			) }

			<Section title="Identity">
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

			<Section title="Routing">
				<TargetsField
					node={ node }
					nodeNames={ nodeNames }
					targets={ ( parsed?.edges || [] ).filter(
						( e ) => e.from === node.id
					) }
					onConnect={ onConnect }
					onRemoveEdge={ onRemoveEdge }
				/>
			</Section>

			<Section title="Constructor">
				{ ctorSpecs.length === 0 && (
					<div className="topology-edit-empty">
						No constructor arguments.
					</div>
				) }
				{ ctorSpecs.map( ( spec, i ) => (
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

			<Section title="Verbs">
				{ verbSpecs.length === 0 && (
					<div className="topology-edit-empty">
						No verbs registered.
					</div>
				) }
				{ verbSpecs.map( ( vspec ) => {
					const idx = verbInvocations.findIndex(
						( inv ) => inv.verb === vspec.name
					);
					const invocation = idx >= 0 ? verbInvocations[ idx ] : null;
					const handleToggle = ( on ) => {
						if ( ! onUpdateVerbs ) {
							return;
						}
						if ( on && idx < 0 ) {
							onUpdateVerbs( node.id, [
								...verbInvocations,
								{
									verb: vspec.name,
									args: ( vspec.args || [] ).map( () => '' ),
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
							key={ vspec.name }
							spec={ vspec }
							invocation={ invocation }
							nodeNames={ nodeNames }
							formatters={ formatters }
							onToggle={ handleToggle }
							onArgChange={ handleArgChange }
						/>
					);
				} ) }
			</Section>
		</aside>
	);
}

export default function Inspector( {
	selectedId,
	parsed,
	streamStatus,
	rateInfo,
	onAction,
	onSelect,
	onHover,
	nodeIds,
	ssePid,
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
	if ( ! selectedId ) {
		return (
			<aside className="topology-inspector">
				<div className="topology-insp__empty">
					Select a node to inspect
				</div>
			</aside>
		);
	}

	const node = parsed.nodes.find( ( n ) => n.id === selectedId );
	if ( ! node ) {
		return (
			<aside className="topology-inspector">
				<div className="topology-insp__empty">
					{ selectedId } no longer present
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
	const type = node.class;
	const live = streamStatus === 'open';

	// Button state derived from server metadata, not client bookkeeping.
	const traceOn = node.debugState > 0;
	// The worker stamps `_repl/` onto incoming FROM, so a tail from this
	// session lands as `_repl/_output/{sse_pid}` — match that stored form.
	const tailOn =
		ssePid &&
		parsed.edges.some(
			( e ) =>
				e.from === selectedId && e.to === `_repl/_output/${ ssePid }`
		);

	return (
		<aside className="topology-inspector">
			<h2 className="topology-insp__title">{ node.id }</h2>
			<div className="topology-insp__type">
				<span
					className={ `topology-insp__led${
						live ? ' is-pulsing' : ''
					}` }
				/>
				{ type } · { live ? 'LIVE' : streamStatus.toUpperCase() }
			</div>

			<Section title="Routing">
				<div className="topology-field-row">
					<span className="topology-field-row__key">target →</span>
					<NodeLinks
						names={ targets.slice( 0, 1 ).map( ( t ) => t.to ) }
						nodeIds={ nodeIds }
						onSelect={ onSelect }
						onHover={ onHover }
					/>
				</div>
				{ targets.length > 1 && (
					<div className="topology-field-row">
						<span className="topology-field-row__key">also →</span>
						<NodeLinks
							names={ targets.slice( 1 ).map( ( t ) => t.to ) }
							nodeIds={ nodeIds }
							onSelect={ onSelect }
							onHover={ onHover }
						/>
					</div>
				) }
				{ /* sink + from dropped — substrate plumbing, no edit-mode equivalent. */ }
			</Section>

			{ ( rateInfo?.hasMessages ||
				rateInfo?.hasRead ||
				rateInfo?.hasWritten ) && (
				<Section title="Activity" meta="last ~60s">
					{ rateInfo.hasMessages && (
						<SparklineRow
							label="messages /s"
							history={ rateInfo.history }
							currentValue={ rateInfo.rate || 0 }
							format={ formatRate }
						/>
					) }
					{ rateInfo.hasRead && (
						<SparklineRow
							label="bytes read /s"
							history={ rateInfo.readHistory }
							currentValue={ rateInfo.readRate || 0 }
							format={ formatByteRate }
						/>
					) }
					{ rateInfo.hasWritten && (
						<SparklineRow
							label="bytes written /s"
							history={ rateInfo.writtenHistory }
							currentValue={ rateInfo.writtenRate || 0 }
							format={ formatByteRate }
						/>
					) }
				</Section>
			) }

			<Section title="Throughput" meta="cumulative">
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

			<div className="topology-insp__actions">
				<button
					type="button"
					onClick={ () => onAction && onAction( 'dump', node.id ) }
					disabled={ ! live }
					title="Send `dump_node <name>` to the worker"
				>
					Dump
				</button>
				<button
					type="button"
					onClick={ () => {
						// eslint-disable-next-line no-alert
						const payload = window.prompt(
							`Send bytes to ${ node.id }:`,
							''
						);
						if ( payload !== null && payload !== '' ) {
							if ( onAction ) {
								onAction( 'send', node.id, payload );
							}
						}
					} }
					disabled={ ! live }
					title="Send a TM_BYTESTREAM payload to this node via `send_node <name> <bytes>`"
				>
					Send
				</button>
				<button
					type="button"
					className={ `topology-insp__actions-full${
						traceOn ? ' is-active' : ''
					}` }
					onClick={ () =>
						onAction &&
						onAction( 'trace', node.id, traceOn ? 0 : 1 )
					}
					disabled={ ! live }
					title={
						traceOn
							? 'Stop tracing — `debug_state <name> 0`'
							: 'Start tracing — `debug_state <name> 1`'
					}
				>
					{ traceOn ? 'Stop Trace' : 'Trace' }
				</button>
				{ type === 'Tee' && (
					<button
						type="button"
						className={ `topology-insp__actions-full${
							tailOn ? ' is-active' : ''
						}` }
						onClick={ () =>
							onAction &&
							onAction( tailOn ? 'disconnect' : 'tail', node.id )
						}
						disabled={ ! live }
						title={
							tailOn
								? 'Disconnect this session from the Tee — `disconnect_node <name>`'
								: 'Connect this session to the Tee — `connect_node <name>` (its output then flows into the transcript)'
						}
					>
						{ tailOn ? 'Disconnect' : 'Connect' }
					</button>
				) }
				{ /* TM_REQUEST verbs from this class's node_schema. */ }
				{ ( () => {
					const schema = catalog.find(
						( c ) => c.shell_name === type
					);
					const requests =
						schema && schema.requests ? schema.requests : [];
					return requests.map( ( req ) => (
						<button
							key={ req.name }
							type="button"
							className="topology-insp__actions-full"
							onClick={ () =>
								onAction &&
								onAction( 'request', node.id, req.name )
							}
							disabled={ ! live }
							title={
								req.description ||
								`Send TM_REQUEST ${ req.name }`
							}
						>
							{ req.name }
						</button>
					) );
				} )() }
			</div>
		</aside>
	);
}
