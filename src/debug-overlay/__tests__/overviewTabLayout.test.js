import path from 'path';
import * as sass from 'sass';
import postcss from 'postcss';
import { render } from '@testing-library/react';
import OverviewTab from '../tabs/OverviewTab';
import { IoTelemetry } from '../../runtime/io-telemetry';

const SCSS = path.resolve( __dirname, '../tabs/overview-tab.scss' );
const stylesheet = postcss.parse( sass.compile( SCSS ).css, { from: SCSS } );

const declarations = ( element ) => {
	const found = {};
	stylesheet.walkRules( ( rule ) => {
		if ( element.matches( rule.selector ) ) {
			rule.walkDecls( ( d ) => {
				found[ d.prop ] = d.value;
			} );
		}
	} );
	return found;
};

function renderPanel() {
	IoTelemetry.reset();
	IoTelemetry.recordError( 1, 'ERROR: tango-5518' );
	const { getByTestId } = render(
		<div className="nodes-debug__panel">
			<OverviewTab publishHeader={ () => {} } />
		</div>
	);
	const tab = getByTestId( 'overview-tab' );
	return {
		tab,
		messages: getByTestId( 'overview-messages' ),
		list: getByTestId( 'overview-messages' ).querySelector( 'ul' ),
		panels: tab.querySelector( '.nodes-overview__panels' ),
		toolbar: tab.querySelector( '.nodes-overview__toolbar' ),
	};
}

// The list fills the tab below the charts instead of a fixed-height box
// that scrolls inside the tab's own scroll and leaves the rest empty.
describe( 'Overview message list layout', () => {
	it( 'lays the tab out as a column', () => {
		const { tab } = renderPanel();
		expect( declarations( tab ) ).toMatchObject( {
			display: 'flex',
			'flex-direction': 'column',
		} );
	} );

	it( 'grows the messages section into the space left', () => {
		const { messages } = renderPanel();
		expect( declarations( messages ) ).toMatchObject( {
			flex: '1 0 320px',
			display: 'flex',
			'flex-direction': 'column',
		} );
	} );

	it( 'scrolls the list within that space, uncapped', () => {
		const { list } = renderPanel();
		const d = declarations( list );
		expect( d ).toMatchObject( { flex: '1 1 0', 'overflow-y': 'auto' } );
		expect( d ).not.toHaveProperty( 'max-height' );
	} );

	// A column's margins add rather than collapse, so the station's block
	// gaps (cards 18px, panels 12px, messages 18px) come from one side each.
	it( 'keeps the block-layout gaps between the sections', () => {
		const { panels, toolbar } = renderPanel();
		expect( declarations( panels ) ).toMatchObject( { 'margin-top': '0' } );
		expect( declarations( toolbar ) ).toMatchObject( { margin: '0' } );
	} );
} );
