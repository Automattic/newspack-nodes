/* eslint-env jest */
/**
 * mountStationEditor — a station page's layout editor, mounted under the
 * page's own heading, on a page sending for the station's group and
 * offering no restore inside the editor.
 */

jest.mock(
	'@newspack-nodes/shared/composition/page/mountComposedEditor',
	() => ( { mountComposedEditor: jest.fn() } )
);

import { render, screen } from '@testing-library/react';
import { mountComposedEditor } from '@newspack-nodes/shared/composition/page/mountComposedEditor';
import { usePage } from '@newspack-nodes/shared/composition/page';
import { mountStationEditor } from '../stationEditor';

/** The views, distinct from any page's. */
const VIEWS = { 'newspack-nodes/kahu-7940': { View: () => null } };

/** A block reading the page it stands on. */
function Page() {
	const { group, canTune } = usePage();
	return <p>{ `${ group } ${ canTune }` }</p>;
}

it.each( [
	[ 'newspack-nodes/station-overview', 'Edit the Overview layout' ],
	[ 'newspack-nodes/station-jobs', 'Edit the Jobs layout' ],
	[ 'newspack-nodes/station-tables', 'Edit the Tables layout' ],
	[ 'newspack-nodes/station-aggregator', 'Edit the Aggregator layout' ],
] )( 'mounts %s under its page’s heading', ( context, heading ) => {
	const localized = { context, blocks: {}, patterns: [], inline: [] };
	mountStationEditor( localized, VIEWS );
	const [ handed, views, options ] = mountComposedEditor.mock.calls.at( -1 );
	expect( handed ).toBe( localized );
	expect( views ).toBe( VIEWS );
	expect( options.heading ).toBe( heading );
} );

it( 'stands the editor on a page sending for the station group', () => {
	mountStationEditor(
		{
			context: 'newspack-nodes/station-jobs',
			blocks: {},
			patterns: [],
			inline: [],
		},
		VIEWS
	);
	const [ , , { wrap } ] = mountComposedEditor.mock.calls.at( -1 );
	render( wrap( <Page />, {} ) );
	expect( screen.getByText( 'station false' ) ).toBeTruthy();
} );

it( 'refuses a context no station page lays out', () => {
	expect( () =>
		mountStationEditor(
			{
				context: 'newspack-nodes/kahu-7940',
				blocks: {},
				patterns: [],
				inline: [],
			},
			VIEWS
		)
	).toThrow( /newspack-nodes\/kahu-7940/ );
} );
