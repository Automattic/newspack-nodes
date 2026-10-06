/**
 * One text field that holds a draft and hands it to its owner on Enter, on
 * blur or on a pick from its suggestions. The topology console's name and
 * node-path fields are built on it, and any field committing typed text — a
 * token input, a time box — is one.
 */

import { useEffect, useId, useRef, useState } from '@wordpress/element';

/**
 * A value the `<datalist>` offers: the text itself, or the text and a label.
 *
 * @typedef {string|{value: string, label?: string}} Suggestion
 */

/**
 * A suggestion as the option it draws.
 *
 * @param {Suggestion} suggestion The text, or the text and a label.
 * @return {{value: string, label?: string}} The option.
 */
const optionOf = ( suggestion ) =>
	'string' === typeof suggestion ? { value: suggestion } : suggestion;

/**
 * Whether one keystroke turns one text into the other: a character typed,
 * deleted or typed over.
 *
 * @param {string} before The text ahead of the edit.
 * @param {string} after  The text after it.
 * @return {boolean} Whether the edit is one character.
 */
const oneKeystroke = ( before, after ) => {
	const [ short, long ] =
		before.length < after.length ? [ before, after ] : [ after, before ];
	const grown = long.length - short.length;
	if ( grown > 1 ) {
		return false;
	}
	let same = 0;
	while ( same < short.length && short[ same ] === long[ same ] ) {
		same++;
	}
	return short.slice( same + 1 - grown ) === long.slice( same + 1 );
};

/**
 * Whether an edit picked a suggestion rather than typed toward one. A browser
 * filling the box from its list says so through `insertReplacementText`;
 * one that names no inputType filled it when the text jumped further than a
 * keystroke reaches.
 *
 * @param {Event}        event       The native input event.
 * @param {string}       before      The text ahead of the edit.
 * @param {string}       after       The text after it.
 * @param {Suggestion[]} suggestions The values offered.
 * @return {boolean} Whether the edit is a pick.
 */
const picked = ( event, before, after, suggestions ) => {
	if ( ! suggestions.some( ( s ) => optionOf( s ).value === after ) ) {
		return false;
	}
	const inputType = /** @type {InputEvent} */ ( event ).inputType;
	return inputType
		? 'insertReplacementText' === inputType
		: ! oneKeystroke( before, after );
};

/**
 * What the field takes beyond the input's own attributes.
 *
 * @typedef  {Object}                                                   CommitInputOptions
 * @property {string}                                                           value               What the owner holds now.
 * @property {(draft: string) => ?string}                                       [validate]          Why a trimmed draft is refused, or null.
 * @property {boolean}                                                          [refuseWhileTyping] Show a refusal as the draft is typed; false waits for a commit.
 * @property {(draft: string) => ?string|void}                                  [onCommit]          Takes a changed draft; returns why it refuses one.
 * @property {boolean}                                                          [commitOnBlur]      Commit on blur as well as Enter.
 * @property {(draft: string) => void}                                          [onChange]          Takes each accepted draft as it is typed.
 * @property {(refusal: ?string) => void}                                       [onRefusal]         Takes what refuses the draft, shown or not, or null.
 * @property {Suggestion[]}                                                     [suggestions]       Values offered, never imposed.
 * @property {string}                                                           [refusalClassName]  Class on the refusal; the shared error status by default.
 * @property {string}                                                           [id]                Input id; one is minted when absent.
 * @property {(event: import('react').KeyboardEvent<HTMLInputElement>) => void} [onKeyDown]         The caller's keys, after the field's own.
 */

/**
 * The options, plus every input attribute but the four the field owns.
 *
 * @typedef {CommitInputOptions & Omit<import('react').InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur' | 'onKeyDown'>} CommitInputProps
 */

/**
 * The field: a text input, its suggestion list, and the refusal beneath it.
 *
 * It shows `value` until something is typed, then the draft. Each draft is
 * trimmed before anything reads it, and `validate` reads only one differing
 * from `value`, so a box emptied back to an empty `value` refuses nothing. A
 * draft `validate` refuses is never handed on: it stays in the box with the
 * refusal beneath, announced, the input marked invalid and described by it.
 *
 * A field with `onCommit` commits on Enter, and on blur unless `commitOnBlur`
 * is false, and only a draft differing from `value`. A suggestion picked from
 * the list commits at once, as Enter would, while the same text typed key by
 * key waits for Enter; a refused pick shows its refusal whatever
 * `refuseWhileTyping` says. A browser naming no `inputType` is read by how
 * far the text jumped, so there a pick one character from the typed text
 * reads as a keystroke and waits for Enter. The owner may refuse by
 * returning the reason, which the field shows beside the draft it refused, so
 * the text stays to edit and Enter asks the owner again; a blur does not. A
 * draft the owner takes clears, so the field shows `value`, what the owner
 * holds rather than what was asked, and a field whose `value` stays `''`
 * clears for the next entry. A field with
 * `onChange` reports each draft `validate` accepts as it is typed instead.
 * A refused draft never reaches `onChange`, so an owner reading the accepted
 * value — a dialog with a submit button — learns of it through `onRefusal`.
 * That hears what refuses the draft, whether shown or held back by
 * `refuseWhileTyping`, on mount and on every change, and null on unmount.
 *
 * Enter prevents its default to commit, and to hold a draft while a refusal
 * stands, when it stops there too, so a refused draft never reaches a parent
 * form or dialog. In a field with `onCommit` whose `value` is `''`, Enter on a
 * draft of only spaces prevents its default and discards the draft, since
 * there is nothing to commit, while Enter in a truly empty box reaches the
 * parent. Escape
 * drops the draft and the refusal, and stops there only when it dropped
 * something. A new `value` drops both too.
 *
 * Everything else — `id`, `className`, `placeholder`, `aria-label` — goes to
 * the input. A caller's `onKeyDown` runs after the field's own keys, which is
 * where a token list takes Backspace in an empty box.
 *
 * @param {CommitInputProps} props The options and the input's attributes.
 * @return {import('react').ReactElement} The input, its list and its refusal.
 */
export default function CommitInput( {
	value,
	validate,
	refuseWhileTyping = true,
	onCommit,
	commitOnBlur = true,
	onChange,
	onRefusal,
	suggestions = [],
	refusalClassName = 'newspack-nodes-status is-error',
	id,
	onKeyDown,
	...inputProps
} ) {
	const mintedId = useId();
	const inputId = id ?? mintedId;
	const [ draft, setDraft ] = useState( null );
	const [ refusal, setRefusal ] = useState( null );
	// An inline-arrow caller would otherwise re-run the report every render.
	const onRefusalRef = useRef( onRefusal );
	onRefusalRef.current = onRefusal;

	useEffect( () => {
		setDraft( null );
		setRefusal( null );
	}, [ value ] );

	const text = draft ?? value;
	const trimmed = text.trim();
	const changed = null !== draft && trimmed !== value;
	const pending = !! onCommit && changed;
	const invalidDraft = ( changed && validate?.( trimmed ) ) || null;
	const standing = refusal || invalidDraft;

	useEffect( () => {
		onRefusalRef.current?.( standing );
	}, [ standing ] );

	useEffect( () => () => onRefusalRef.current?.( null ), [] );

	/**
	 * Hand a draft to the owner, or show why it cannot be. A draft the owner
	 * declines stays in the box beside its reason.
	 *
	 * @param {string}  next    The trimmed draft.
	 * @param {?string} refused What refuses it, or null.
	 * @return {boolean} Whether it was refused.
	 */
	const commit = ( next, refused ) => {
		if ( refused ) {
			setRefusal( refused );
			return true;
		}
		const declined = onCommit( next ) || null;
		if ( null === declined ) {
			setDraft( null );
		}
		setRefusal( declined );
		return null !== declined;
	};

	/**
	 * Enter commits, drops a draft of only spaces over an empty `value` in a
	 * field with `onCommit`, or stays put while `validate` refuses; Escape drops
	 * the draft.
	 *
	 * @param {import('react').KeyboardEvent<HTMLInputElement>} event The key.
	 */
	const keyDown = ( event ) => {
		if ( 'Enter' === event.key && pending ) {
			event.preventDefault();
			if ( commit( trimmed, invalidDraft ) ) {
				event.stopPropagation();
			}
		} else if (
			'Enter' === event.key &&
			onCommit &&
			'' === value &&
			text &&
			! trimmed
		) {
			event.preventDefault();
			setDraft( null );
		} else if ( 'Enter' === event.key && standing ) {
			event.preventDefault();
			event.stopPropagation();
			setRefusal( standing );
		} else if (
			'Escape' === event.key &&
			( ( null !== draft && draft !== value ) || refusal )
		) {
			event.preventDefault();
			event.stopPropagation();
			setDraft( null );
			setRefusal( null );
		}
		onKeyDown?.( event );
	};

	const listId = `${ inputId }-suggestions`;
	const refusalId = `${ inputId }-refusal`;
	return (
		<>
			<input
				type="text"
				autoComplete="off"
				spellCheck={ false }
				{ ...inputProps }
				id={ inputId }
				list={ suggestions.length ? listId : undefined }
				value={ text }
				aria-invalid={ refusal ? true : undefined }
				aria-describedby={ refusal ? refusalId : undefined }
				onChange={ ( event ) => {
					const raw = event.target.value;
					const next = raw.trim();
					const invalid =
						( next !== value && validate?.( next ) ) || null;
					setDraft( raw );
					setRefusal( refuseWhileTyping ? invalid : null );
					if ( ! invalid ) {
						onChange?.( next );
					}
					if (
						onCommit &&
						next !== value &&
						picked( event.nativeEvent, text, raw, suggestions )
					) {
						commit( next, invalid );
					}
				} }
				onBlur={ () => {
					if ( commitOnBlur && pending ) {
						commit( trimmed, standing );
					}
				} }
				onKeyDown={ keyDown }
			/>
			{ suggestions.length > 0 && (
				<datalist id={ listId }>
					{ suggestions.map( ( s ) => {
						const option = optionOf( s );
						return (
							<option
								key={ option.value }
								value={ option.value }
								label={ option.label }
							/>
						);
					} ) }
				</datalist>
			) }
			{ refusal && (
				<span
					id={ refusalId }
					role="alert"
					className={ refusalClassName }
				>
					{ refusal }
				</span>
			) }
		</>
	);
}
