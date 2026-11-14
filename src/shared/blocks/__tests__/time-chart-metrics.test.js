/* eslint-env jest */
/**
 * A time-chart block naming several metrics draws one panel over every
 * metric's series, each named after its metric, titled by the metrics'
 * labels when the block sets no title.
 */

import { render, screen } from '@testing-library/react';
import { Core } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { holdRouterCadence } from '@newspack-nodes/shared/test-utils/holdRouterCadence';
import { registerSource, SourcesProvider } from '../../sources';
import timeChart from '../time-chart';

const SERIES = ( top ) => ( {
	Kea: {
		points: [
			{ ts: 1767225600, value: top - 3 },
			{ ts: 1767225615, value: top },
		],
		max: top,
	},
} );

registerSource( 'weka-7861', {
	kind: 'poll',
	group: 'alpine-7861',
	ci: 'tern-7861',
	command: 'chime',
	args: () => [],
	transform: () => ( { climb: SERIES( 9 ), dive: SERIES( 5 ) } ),
	intervalMs: 7000,
	fields: {
		climb: { label: 'Climb 7861', kind: 'series' },
		dive: { label: 'Dive 7861', kind: 'series' },
	},
} );

it( 'prefixes each series with its metric and titles the panel by the metrics', async () => {
	Core.reset();
	holdRouterCadence();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	installFakeCommandWire( () => ( {} ) );
	const { View } = timeChart;
	render(
		<SourcesProvider>
			<View
				attributes={ {
					source: 'weka-7861',
					metrics: [ 'climb', 'dive' ],
					stacked: false,
					title: '',
				} }
				editing={ false }
			/>
		</SourcesProvider>
	);
	expect( await screen.findByText( 'Climb 7861 · Dive 7861' ) ).toBeTruthy();
	expect( await screen.findByText( 'Climb 7861: Kea' ) ).toBeTruthy();
	expect( await screen.findByText( 'Dive 7861: Kea' ) ).toBeTruthy();
} );
