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
