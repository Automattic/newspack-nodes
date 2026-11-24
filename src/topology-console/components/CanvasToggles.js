/**
 * CanvasToggles — which canvas the console draws, and how the force canvas
 * draws it. GraphView owns the flags and hands this to the Inspector, whose
 * button style it wears.
 */

import { __ } from '@wordpress/i18n';
import { classes } from '@newspack-nodes/shared/components/Modal';

/**
 * The toggles: the force canvas, and while it is on, what acts on it alone.
 *
 * @param {Object}     props
 * @param {boolean}    props.force   Whether the force canvas shows.
 * @param {boolean}    props.sinks   Whether it draws sinks.
 * @param {boolean}    props.warm    Whether its layout keeps moving.
 * @param {() => void} props.onForce Runs on a press of the first.
 * @param {() => void} props.onSinks Runs on a press of the second.
 * @param {() => void} props.onWarm  Runs on a press of the third.
 * @return {import('react').ReactElement} The toggles, as a section of the Inspector.
 */
export default function CanvasToggles( {
	force,
	sinks,
	warm,
	onForce,
	onSinks,
	onWarm,
} ) {
	return (
		<div className="topology-insp__section">
			<div className="topology-insp__commands">
				<Toggle
					className="topology-insp__actions-full"
					isOn={ force }
					onToggle={ onForce }
				>
					{ __( 'Force canvas', 'newspack-nodes' ) }
				</Toggle>
				{ force && (
					<>
						<Toggle isOn={ sinks } onToggle={ onSinks }>
							{ __( 'Show sinks', 'newspack-nodes' ) }
						</Toggle>
						<Toggle isOn={ warm } onToggle={ onWarm }>
							{ __( 'Keep warm', 'newspack-nodes' ) }
						</Toggle>
					</>
				) }
			</div>
		</div>
	);
}

/**
 * One toggle.
 *
 * @param {Object}                    props
 * @param {boolean}                   props.isOn        Whether it is on.
 * @param {() => void}                props.onToggle    Runs on a press.
 * @param {string}                    [props.className] A class beside its style.
 * @param {import('react').ReactNode} props.children    Its label.
 * @return {import('react').ReactElement} The button.
 */
function Toggle( { isOn, onToggle, className, children } ) {
	return (
		<button
			type="button"
			className={ classes(
				'button is-compact',
				isOn && 'is-active',
				className
			) }
			aria-pressed={ isOn }
			onClick={ onToggle }
		>
			{ children }
		</button>
	);
}
