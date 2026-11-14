/**
 * Aggregator station-tab descriptor — everything but the component. Shared by
 * `./tabs` (full registration when the bundle loads) and the station's lazy
 * placeholder, so the tab bar identity matches before the bundle loads. A
 * second spelling of it would rename, reorder or duplicate the tab the moment
 * the bundle arrives.
 *
 * It claims `edit`, the param its layout editor loads on, so the station
 * keeps it while the bundle loads, and asks its layout before a switch.
 *
 * Order 40 lands it after Sessions (35), at the end of the substrate's station
 * bar: every tab before it reads this install, while the Aggregator reads the
 * spokes.
 */

import { __ } from '@wordpress/i18n';
import { beforeStationLeave } from '../station/leaveGuard';

export default {
	id: 'aggregator',
	label: __( 'Aggregator', 'newspack-nodes' ),
	host: 'station',
	slug: 'aggregator',
	params: [ 'edit' ],
	beforeLeave: beforeStationLeave,
	order: 40,
	handle: 'newspack-nodes-aggregator-tab',
};
