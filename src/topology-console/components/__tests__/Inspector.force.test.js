/**
 * Where the Inspector renders the canvas toggles it is handed: first in the
 * panel shown with nothing selected, live and in a draft, and nowhere else.
 */

import Inspector from '../Inspector';
import { renderWithCatalog } from '../../__tests__/catalogTestUtils';

const PARSED = {
	nodes: [
		{ id: 'press-61', class: 'Press', origin: [ 'dock' ] },
		{ id: 'vat-33', class: 'Vat' },
	],
	edges: [ { from: 'press-61', to: 'vat-33' } ],
};

/**
 * Render the Inspector over PARSED, the toggles a marked stand-in.
 *
 * @param {Object} props Props over those.
 * @return {{panel: HTMLElement, toggles: ?HTMLElement}} The panel, and the stand-in.
 */
const mount = ( props ) => {
	const { container } = renderWithCatalog(
		<Inspector
			selectedId={ null }
			parsed={ PARSED }
			tree={ { dock: {} } }
			includes={ [ 'dock' ] }
			hulls={ [ { include: 'dock', nodeIds: [ 'press-61' ] } ] }
			currentTopology="quay"
			rateSeries={ { in: [], out: [], read: [], write: [] } }
			hullRateSeries={ { in: [], out: [], read: [], write: [] } }
			canvasToggles={ <p data-testid="toggles">toggles</p> }
			{ ...props }
		/>
	);
	return {
		panel: container.querySelector( '.topology-inspector' ),
		toggles: container.querySelector( '[data-testid="toggles"]' ),
	};
};

describe( 'the canvas toggles in the Inspector', () => {
	it( 'come first in the live panel with nothing selected', () => {
		const { panel, toggles } = mount( {} );
		expect( panel.textContent ).toContain( '_command_interpreter' );
		expect( panel.firstElementChild ).toBe( toggles );
	} );

	it( 'come first in the panel of the edited topology', () => {
		const { panel, toggles } = mount( { editMode: true } );
		expect( panel.textContent ).toContain( 'quay' );
		expect( panel.querySelector( 'h3' ).textContent ).toBe( 'quay' );
		expect( panel.firstElementChild ).toBe( toggles );
	} );

	it.each( [
		[ 'a hull', { selectedHull: 'dock' } ],
		[ 'a hull in a draft', { selectedHull: 'dock', editMode: true } ],
		[ 'a node', { selectedId: 'vat-33' } ],
		[ 'a node in a draft', { selectedId: 'vat-33', editMode: true } ],
		[ 'a borrowed node', { selectedId: 'press-61', editMode: true } ],
		[ 'a node that is gone', { selectedId: 'cask-5' } ],
	] )( 'do not show over the selection of %s', ( _, props ) => {
		const { panel, toggles } = mount( props );
		expect( panel ).not.toBeNull();
		expect( toggles ).toBeNull();
	} );
} );
