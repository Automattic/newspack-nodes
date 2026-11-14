/* eslint-env jest */
/**
 * The probe-table block's inspector offers the probe logs the block's
 * declared `source` schema enumerates, each by the words its table is
 * presented with, so the PHP declaration is the one list of tables.
 */

import { render, screen } from '@testing-library/react';
import probeTable from '../blocks/probe-table';

const { Controls } = probeTable;

it( 'offers each probe the declared schema enumerates, by its table’s words', () => {
	render(
		<Controls
			attributes={ { source: 'nodes/tablestats' } }
			setAttributes={ () => {} }
			schema={ {
				source: {
					type: 'string',
					enum: [ 'nodes/tablestats' ],
					default: 'nodes/tablestats',
				},
			} }
		/>
	);
	expect(
		screen
			.getAllByRole( 'option' )
			.map( ( option ) => [ option.value, option.textContent ] )
	).toEqual( [ [ 'nodes/tablestats', 'Tables' ] ] );
} );
