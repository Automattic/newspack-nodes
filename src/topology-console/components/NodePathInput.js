/**
 * A node path typed as text, with the graph's own node names as suggestions.
 *
 * A route names a path, not only a local node: `url:shell/_http/performance`
 * reaches a node in another process, which no picker over this graph can
 * offer. A native `<input list>` over a `<datalist>` suggests without
 * restricting, where WordPress's ComboboxControl refuses free text. A TSL token
 * holds no unquoted space, so a value holding one is refused with a hint
 * rather than handed on.
 */

import { __ } from '@wordpress/i18n';
import CommitInput from '@newspack-nodes/shared/components/CommitInput';

/**
 * Why a trimmed path is refused, or null.
 *
 * @param {string} path The trimmed path.
 * @return {?string} The refusal.
 */
const refusePath = ( path ) =>
	/\s/.test( path )
		? __( 'A node path cannot hold a space.', 'newspack-nodes' )
		: null;

/**
 * Renders a `CommitInput` that refuses a path holding a space.
 *
 * Two callbacks, for two editors. `onChange` reports every acceptable edit, as
 * the draft-backed argument fields and the dialogs reading them on Enter do;
 * `onCommit` reports once, on Enter or blur, as the routing editors want a
 * single `connect_node` per edit, and `commitOnBlur: false` leaves it Enter
 * alone. `onRefusal` tells an `onChange` owner that the box holds a path it
 * never received.
 *
 * @param {Object}                     props
 * @param {string}                     props.id             Input id; also keys the suggestion list.
 * @param {string}                     props.value          The path the graph holds now.
 * @param {string[]}                   props.suggestions    Local node names offered.
 * @param {string}                     [props.placeholder]  Shown while empty.
 * @param {(path: string) => void}     [props.onChange]     Each acceptable edit.
 * @param {(path: string) => void}     [props.onCommit]     Enter or blur on a changed value.
 * @param {boolean}                    [props.commitOnBlur] Commit on blur as well as Enter; true by default.
 * @param {(refusal: ?string) => void} [props.onRefusal]    The refusal shown, or null, as it changes.
 * @return {import('react').ReactElement} The input, list and hint.
 */
export function NodePathInput( props ) {
	return (
		<CommitInput
			className="topology-edit-row__input"
			refusalClassName="topology-edit-row__hint"
			validate={ refusePath }
			{ ...props }
		/>
	);
}
