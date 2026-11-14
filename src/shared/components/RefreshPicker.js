/**
 * RefreshPicker — the one select a dashboard picks its poll cadence with.
 * Each option keeps the value it declares, a number or a string, and the
 * select hands that value back, never the text the DOM holds.
 */

import { __ } from '@wordpress/i18n';

/**
 * One cadence the picker offers.
 *
 * @typedef {Object} RefreshOption
 * @property {string}        label What the option reads.
 * @property {number|string} value What choosing it hands back.
 */

/**
 * @param {Object}                         props
 * @param {number|string}                  props.value    The chosen option's value.
 * @param {RefreshOption[]}                props.options  The cadences offered.
 * @param {(value: number|string) => void} props.onChange Takes the value picked, in its option's type.
 * @param {string}                         [props.title]  A hover hint, such as a key the page binds.
 * @return {import('react').ReactElement} The select.
 */
export default function RefreshPicker( { value, options, onChange, title } ) {
	return (
		<select
			className="newspack-nodes-select"
			value={ value }
			onChange={ ( event ) =>
				onChange(
					options.find(
						( option ) =>
							String( option.value ) === event.target.value
					).value
				)
			}
			aria-label={ __( 'Refresh interval', 'newspack-nodes' ) }
			title={ title }
		>
			{ options.map( ( option ) => (
				<option key={ option.value } value={ option.value }>
					{ option.label }
				</option>
			) ) }
		</select>
	);
}
