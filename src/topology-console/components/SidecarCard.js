/**
 * SidecarCard — one sidecar in its owner's grid, drawn as the card the canvas
 * would draw for it, and the button that picks it.
 */

import { __, sprintf } from '@wordpress/i18n';
import {
	NODE_H,
	NODE_SHADOW,
	NODE_W,
	NodeCard,
	NodeReadout,
	formatNodeRate,
	sparklinePath,
} from './NodeCard';

/** @typedef {import('../../runtime/metadata-node').MetadataGraphNode} MetadataGraphNode */
/** @typedef {import('../hooks/useGraphRates').RateEntry} RateEntry */

/**
 * One sidecar as the card the canvas would draw for it, its frame in the
 * group the glowing skins bloom, and a button picking it.
 *
 * @param {Object}                                 props
 * @param {string}                                 props.surface    The grid's id prefix.
 * @param {{name: string, class: string}}          props.sidecar    The sidecar its owner lists.
 * @param {MetadataGraphNode}                      [props.row]      Its polled row; absent before the first answer.
 * @param {RateEntry}                              [props.rate]     Its rate; absent before a second answer.
 * @param {import('react').Ref<HTMLButtonElement>} [props.focusRef] Set on the card focused as the grid opens.
 * @param {(name: string) => void}                 props.onPick     Shows the sidecar.
 * @return {import('react').ReactElement} The card's button.
 */
export default function SidecarCard( {
	surface,
	sidecar,
	row,
	rate,
	focusRef,
	onPick,
} ) {
	const isIdle = ! ( rate?.rate > 0 );
	return (
		<button
			ref={ focusRef }
			type="button"
			className="button-link topology-sidecars__card"
			aria-label={ sprintf(
				// translators: 1: a node's name, 2: its class.
				__( '%1$s (%2$s)', 'newspack-nodes' ),
				sidecar.name,
				sidecar.class
			) }
			onClick={ () => onPick( sidecar.name ) }
		>
			<svg
				width={ NODE_W + NODE_SHADOW }
				height={ NODE_H + NODE_SHADOW }
				viewBox={ `0 0 ${ NODE_W + NODE_SHADOW } ${
					NODE_H + NODE_SHADOW
				}` }
			>
				<g className="topology-nodes topology-nodes--bloom">
					<NodeCard
						surface={ surface }
						id={ sidecar.name }
						cls={ sidecar.class }
						isIdle={ isIdle }
						isPaused={ 'PAUSED' === row?.polling }
					/>
				</g>
				<NodeReadout
					surface={ surface }
					isIdle={ isIdle }
					sparkPath={ sparklinePath( rate?.history ) }
					rateText={ formatNodeRate( rate?.rate ) }
					count={ row?.count }
				/>
			</svg>
		</button>
	);
}
