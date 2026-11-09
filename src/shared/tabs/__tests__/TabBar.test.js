/**
 * Tests for TabBar — a tablist with one tab stop and arrow keys on a wide
 * screen, one select labelled "View" under NARROW_PX, and the panel props
 * that match whichever form the bar takes.
 */

import { render, fireEvent, screen, act } from '@testing-library/react';
import { useState } from '@wordpress/element';
import TabBar, { tabDomId, panelDomId, useTabPanelProps } from '../TabBar';
import { installViewport } from '../../test-utils/viewportWidth';

const TABS = [
	{ id: 'briefing', label: 'Briefing' },
	{ id: 'search', label: 'Search' },
	{ id: 'review', label: 'Review' },
];

/**
 * A page holding its own view state, as a consumer of the bar does.
 *
 * @param {Object} props
 * @param {string} props.initial The tab selected first.
 * @return {import('react').ReactElement} The bar, its panel and a bystander.
 */
function Page( { initial } ) {
	const [ active, setActive ] = useState( initial );
	const panelProps = useTabPanelProps( 'probe', active, true );
	return (
		<>
			<TabBar
				scope="probe"
				label="Probe views"
				tabs={ TABS }
				activeId={ active }
				onPick={ setActive }
			/>
			<div { ...panelProps } data-testid="panel">
				{ active }
			</div>
			<button type="button">Elsewhere</button>
		</>
	);
}

describe( 'TabBar', () => {
	let viewport;
	afterEach( () => viewport.restore() );

	describe( 'narrow', () => {
		beforeEach( () => {
			viewport = installViewport( true );
		} );

		it( 'renders one select labelled "View" in place of the tablist', () => {
			render( <Page initial="search" /> );
			expect( screen.queryByRole( 'tablist' ) ).toBeNull();
			expect( screen.getAllByRole( 'combobox' ) ).toHaveLength( 1 );
			const select = screen.getByLabelText( 'View' );
			expect( select.value ).toBe( 'search' );
			expect(
				Array.from( select.options ).map( ( o ) => o.textContent )
			).toEqual( [ 'Briefing', 'Search', 'Review' ] );
		} );

		it( 'keeps the bar wrapper the sheets and the inspector measure', () => {
			const { container } = render( <Page initial="search" /> );
			const bar = container.querySelector( '.nodes-tab-host__tabbar' );
			expect( bar.classList.contains( 'is-narrow' ) ).toBe( true );
			expect( bar.hasAttribute( 'role' ) ).toBe( false );
			expect( bar.contains( screen.getByLabelText( 'View' ) ) ).toBe(
				true
			);
		} );

		it( 'selects the tab its option names', () => {
			render( <Page initial="briefing" /> );
			fireEvent.change( screen.getByLabelText( 'View' ), {
				target: { value: 'review' },
			} );
			expect( screen.getByTestId( 'panel' ).textContent ).toBe(
				'review'
			);
			expect( screen.getByLabelText( 'View' ).value ).toBe( 'review' );
		} );

		it( 'hands onPick the chosen id and nothing more', () => {
			const onPick = jest.fn();
			render(
				<TabBar
					scope="probe"
					label="Probe views"
					tabs={ TABS }
					activeId="briefing"
					onPick={ onPick }
				/>
			);
			fireEvent.change( screen.getByLabelText( 'View' ), {
				target: { value: 'review' },
			} );
			expect( onPick.mock.calls ).toEqual( [ [ 'review' ] ] );
		} );

		it( 'leaves the panel unlabelled by any tab, and controlled by the select', () => {
			render( <Page initial="review" /> );
			const panel = screen.getByTestId( 'panel' );
			expect( panel.id ).toBe( panelDomId( 'probe' ) );
			expect( panel.hasAttribute( 'role' ) ).toBe( false );
			expect( panel.hasAttribute( 'aria-labelledby' ) ).toBe( false );
			expect(
				screen.getByLabelText( 'View' ).getAttribute( 'aria-controls' )
			).toBe( panelDomId( 'probe' ) );
		} );
	} );

	describe( 'wide', () => {
		beforeEach( () => {
			viewport = installViewport( false );
		} );

		it( 'keeps one tab stop, on the selected tab', () => {
			render( <Page initial="search" /> );
			expect( screen.queryByLabelText( 'View' ) ).toBeNull();
			const stops = screen
				.getAllByRole( 'tab' )
				.filter( ( tab ) => 0 === tab.tabIndex );
			expect( stops.map( ( tab ) => tab.textContent ) ).toEqual( [
				'Search',
			] );
		} );

		it( 'moves with the arrow keys and wraps at the end', () => {
			render( <Page initial="search" /> );
			fireEvent.keyDown( screen.getByRole( 'tab', { name: 'Search' } ), {
				key: 'ArrowRight',
			} );
			expect( screen.getByTestId( 'panel' ).textContent ).toBe(
				'review'
			);
			expect( document.activeElement.textContent ).toBe( 'Review' );

			fireEvent.keyDown( screen.getByRole( 'tab', { name: 'Review' } ), {
				key: 'ArrowRight',
			} );
			expect( screen.getByTestId( 'panel' ).textContent ).toBe(
				'briefing'
			);
		} );

		it( 'labels the panel by its tab', () => {
			render( <Page initial="search" /> );
			const panel = screen.getByRole( 'tabpanel' );
			expect( panel.id ).toBe( panelDomId( 'probe' ) );
			expect( panel.getAttribute( 'aria-labelledby' ) ).toBe(
				tabDomId( 'probe', 'search' )
			);
		} );
	} );

	describe( 'crossing the breakpoint', () => {
		it( 'carries focus from the selected tab to the select', () => {
			viewport = installViewport( false );
			render( <Page initial="search" /> );
			act( () => screen.getByRole( 'tab', { name: 'Search' } ).focus() );

			act( () => viewport.setNarrow( true ) );
			expect( document.activeElement ).toBe(
				screen.getByLabelText( 'View' )
			);
		} );

		it( 'carries focus from the select to the selected tab', () => {
			viewport = installViewport( true );
			render( <Page initial="review" /> );
			act( () => screen.getByLabelText( 'View' ).focus() );

			act( () => viewport.setNarrow( false ) );
			expect( document.activeElement ).toBe(
				screen.getByRole( 'tab', { name: 'Review' } )
			);
		} );

		// @longform Some browsers blur a focused control as it is removed, with
		// no relatedTarget; that blur is the flip's own, not focus leaving.
		it( 'carries focus even when the departing control blurs as it goes', () => {
			viewport = installViewport( false );
			render( <Page initial="search" /> );
			const tab = screen.getByRole( 'tab', { name: 'Search' } );
			act( () => tab.focus() );

			viewport.answer( true );
			fireEvent.blur( tab, { relatedTarget: null } );
			act( () => viewport.setNarrow( true ) );
			expect( document.activeElement ).toBe(
				screen.getByLabelText( 'View' )
			);
		} );

		it( 'leaves focus that sits outside the bar where it is', () => {
			viewport = installViewport( false );
			render( <Page initial="search" /> );
			act( () => screen.getByRole( 'tab', { name: 'Search' } ).focus() );
			const elsewhere = screen.getByRole( 'button', {
				name: 'Elsewhere',
			} );
			act( () => elsewhere.focus() );

			act( () => viewport.setNarrow( true ) );
			expect( document.activeElement ).toBe( elsewhere );
		} );
	} );

	describe( 'useTabPanelProps', () => {
		/**
		 * Renders the props the hook answers, as data a test can read.
		 *
		 * @param {boolean} shown Whether the bar is shown.
		 * @return {Object} The props.
		 */
		function propsFor( shown ) {
			let props;
			const Probe = () => {
				props = useTabPanelProps( 'probe', 'search', shown );
				return null;
			};
			render( <Probe /> );
			return props;
		}

		it( 'names a tabpanel labelled by its tab while the bar is wide', () => {
			viewport = installViewport( false );
			expect( propsFor( true ) ).toEqual( {
				id: panelDomId( 'probe' ),
				role: 'tabpanel',
				'aria-labelledby': tabDomId( 'probe', 'search' ),
			} );
		} );

		it( 'gives only the id while the bar is narrow', () => {
			viewport = installViewport( true );
			expect( propsFor( true ) ).toEqual( {
				id: panelDomId( 'probe' ),
			} );
		} );

		it( 'gives only the id while no bar is shown', () => {
			viewport = installViewport( false );
			expect( propsFor( false ) ).toEqual( {
				id: panelDomId( 'probe' ),
			} );
		} );
	} );
} );
