/* eslint-env jest */
/**
 * The time-chart block hands its one metric's series map to the panel as the
 * model holds it, so a model that moves for any other field never redraws
 * the chart.
 */

jest.mock( '../../utils/buildAlignedSeries', () => {
	const actual = jest.requireActual( '../../utils/buildAlignedSeries' );
	return {
		...actual,
		buildAlignedSeries: jest.fn( actual.buildAlignedSeries ),
	};
} );

import { render, screen } from '@testing-library/react';
import { Core, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { steppedClock } from '@newspack-nodes/shared/test-utils/steppedClock';
import { registerSource, SourcesProvider, useSource } from '../../sources';
import { buildAlignedSeries } from '../../utils/buildAlignedSeries';
import timeChart from '../time-chart';

/** The poll's cadence, distinct from every default. */
const KOKAKO_MS = 6000;

/** The one series map every answer keeps. */
const CLIMB = {
	Kea: {
		points: [
			{ ts: 1767225600, value: 4 },
			{ ts: 1767225615, value: 9 },
		],
		max: 9,
	},
};

registerSource( 'kokako-7850', {
	kind: 'poll',
	group: 'alpine-7850',
	ci: 'tern-7850',
	command: 'chime',
	args: () => [],
	transform: ( answer ) => ( { ticks: answer.ticks, climb: CLIMB } ),
	intervalMs: KOKAKO_MS,
	fields: { climb: { label: 'Climb 7850', kind: 'series' } },
} );

/**
 * A second reader of the source, showing how many answers it has seen.
 *
 * @return {import('react').ReactElement} The count.
 */
function Ticks() {
	const { model } = useSource( 'kokako-7850' );
	return <p>{ `ticks ${ model?.ticks ?? 0 }` }</p>;
}

test( 'draws once for a series map that stays, however often the model moves', async () => {
	Core.reset();
	const clock = steppedClock();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	let ticks = 0;
	installFakeCommandWire( ( m ) => ( {
		ticks: 'chime' === m[ VALUE ].name ? ( ticks += 1 ) : 0,
	} ) );
	const { View } = timeChart;
	render(
		<SourcesProvider>
			<View
				attributes={ {
					source: 'kokako-7850',
					metrics: [ 'climb' ],
					stacked: false,
					title: 'Ascent 7850',
				} }
				editing={ false }
			/>
			<Ticks />
		</SourcesProvider>
	);
	await screen.findByText( 'Ascent 7850' );
	const drawn = buildAlignedSeries.mock.calls.length;

	await clock.tick( KOKAKO_MS / 1000 );
	await clock.tick( KOKAKO_MS / 1000 );

	expect( await screen.findByText( 'ticks 3' ) ).toBeTruthy();
	expect( buildAlignedSeries.mock.calls.length ).toBe( drawn );
} );
