/**
 * The inspector's layout primitives — a titled section and a key/value row. Used
 * by every panel (Identity, Routing, Constructor, Verbs, the stats views), so
 * they live apart from any one of them.
 */

/**
 * One key/value line inside an inspector section — the panels' smallest unit.
 *
 * @param {Object}                    props
 * @param {string}                    props.k        Field label, shown on the left.
 * @param {import('react').ReactNode} props.v        Already-formatted value, shown on the right.
 * @param {string}                    [props.vClass] Extra classes on the value span, e.g. the numeric, accent, and dim modifiers callers pick per value.
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
 * A titled group of inspector rows — Identity, Routing, Throughput, and so on.
 *
 * @param {Object}                    props
 * @param {string}                    props.title    Section heading.
 * @param {string}                    [props.meta]   Qualifier rendered beside the heading, such as the stats window or `cumulative`; omitted when falsy.
 * @param {import('react').ReactNode} props.children Rows rendered under the heading.
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
