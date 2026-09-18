/**
 * Layout primitives the inspector panels compose: a titled section wrapper and
 * a read-only key/value row. Both carry the canonical `topology-insp__section`
 * and `topology-field-row` markup, so a panel never redeclares heading or row
 * styling, and they sit apart from Inspector and ProcessStats because both
 * import them.
 */

/**
 * One read-only key/value line inside a Section.
 *
 * @param {Object}                    props
 * @param {string}                    props.k        Field label, shown on the left.
 * @param {import('react').ReactNode} props.v        Value shown on the right, already formatted — the row formats nothing itself.
 * @param {string}                    [props.vClass] Extra classes on the value span. The modifiers compose — `--num` right-aligns and bolds, `--dim` only recolors — so a caller passes classes rather than one variant name.
 * @return {import('react').ReactElement} The field row.
 */
export function FieldRow( { k, v, vClass } ) {
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

/**
 * One titled panel of the inspector — Identity, Routing, Throughput, and the rest.
 *
 * @param {Object}                    props
 * @param {string}                    props.title    Section heading.
 * @param {string}                    [props.meta]   Qualifier rendered beside the heading, such as the activity window or `cumulative`; a falsy value omits the span.
 * @param {import('react').ReactNode} props.children Panel body: field rows, editor fields, sparklines or verb buttons.
 * @return {import('react').ReactElement} The section wrapper.
 */
export function Section( { title, meta, children } ) {
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

/**
 * A comma-separated run of node names, each selecting its node when clicked.
 *
 * A name outside `nodeIds` renders as dim text instead: it points at something
 * the graph on screen does not hold, and a button that selects nothing reads
 * as broken.
 *
 * @param {Object}      props
 * @param {string[]}    [props.names]    Names in display order; empty renders an em dash.
 * @param {Set<string>} [props.nodeIds]  Ids present in the graph; anything else is not a link.
 * @param {Function}    [props.onSelect] (name) — selects the clicked node.
 * @param {Function}    [props.onHover]  (name|null) — highlights it on the canvas, null on leave.
 * @return {import('react').ReactElement} The name list.
 */
export function NodeLinks( { names, nodeIds, onSelect, onHover } ) {
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
							className="button button-small topology-field-row__nav"
							onClick={ () => {
								// Unmounting may skip mouseleave.
								onHover?.( null );
								onSelect?.( name );
							} }
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
