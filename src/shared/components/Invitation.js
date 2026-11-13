/**
 * An empty section's words and the one control that acts on them.
 *
 * @param {{text: string, label: string, onClick?: () => void, 'aria-disabled'?: true|'true'}} props
 *                                                                                                   What the section found and what to do, the control's label, what it
 *                                                                                                   does, and `aria-disabled` while it is inert.
 * @return {import('react').ReactElement} The invitation.
 */
export default function Invitation( { text, label, ...control } ) {
	return (
		<>
			{ text }{ ' ' }
			<button type="button" className="button" { ...control }>
				{ label }
			</button>
		</>
	);
}
