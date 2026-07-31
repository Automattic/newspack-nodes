/**
 * OpenTopologyModal — list of saved topologies grouped by source with
 * pick + cancel affordances.
 */

import { render, fireEvent } from '@testing-library/react';
import OpenTopologyModal from '../OpenTopologyModal';

const noop = () => {};

describe( 'OpenTopologyModal', () => {
	// One shell for every dialog: the picker used to carry a private copy, so
	// fixes to the shared one (portal, skin root, anchoring) never reached it.
	it( 'marks the actual wide dialog frame as a canonical modal', () => {
		render(
			<OpenTopologyModal
				topologies={ [
					{
						name: 'modal-contract-probe',
						source: 'both',
						active: true,
					},
				] }
				loading={ false }
				error={ null }
				onPick={ noop }
				onCancel={ noop }
			/>
		);
		const frame = document.body.querySelector(
			'[aria-modal="true"].topology-modal--wide'
		);

		expect( frame ).not.toBeNull();
		expect( frame.className ).toBe(
			'topology-modal newspack-nodes-modal topology-modal--wide'
		);
		expect(
			frame.querySelector( '.topology-modal__header' ).className
		).toBe( 'topology-modal__header newspack-nodes-modal__header' );
		// Portaled through the shared shell, so it carries the skin root.
		expect( frame.closest( '.newspack-nodes-skin-root' ) ).not.toBeNull();
		expect(
			frame.querySelector( '.topology-modal__close' )
		).not.toBeNull();
	} );

	it( 'renders a loading row when loading=true', () => {
		render(
			<OpenTopologyModal
				topologies={ [] }
				loading
				error={ null }
				onPick={ noop }
				onCancel={ noop }
			/>
		);
		expect( document.body.textContent ).toMatch( /Loading/ );
	} );

	it( 'renders an error row when error is set', () => {
		render(
			<OpenTopologyModal
				topologies={ [] }
				loading={ false }
				error="boom"
				onPick={ noop }
				onCancel={ noop }
			/>
		);
		expect( document.body.textContent ).toMatch( /Failed to load/ );
	} );

	it( 'renders an empty-state row when topologies is empty and not loading', () => {
		render(
			<OpenTopologyModal
				topologies={ [] }
				loading={ false }
				error={ null }
				onPick={ noop }
				onCancel={ noop }
			/>
		);
		expect( document.body.textContent ).toMatch(
			/No topologies registered/
		);
	} );

	it( 'groups topologies by source and renders only non-empty groups', () => {
		render(
			<OpenTopologyModal
				topologies={ [
					{ name: 'demo', source: 'user', active: false },
					{ name: 'shipped', source: 'stock', active: true },
				] }
				loading={ false }
				error={ null }
				onPick={ noop }
				onCancel={ noop }
			/>
		);
		const groups = document.body.querySelectorAll(
			'.topology-open-group__title'
		);
		const titles = Array.from( groups ).map( ( g ) => g.textContent );
		// Order = user / both / stock; "both" is skipped because empty.
		expect( titles ).toEqual( [ 'user', 'stock' ] );
	} );

	it( 'shows an "active" badge on active topologies', () => {
		render(
			<OpenTopologyModal
				topologies={ [
					{ name: 'demo', source: 'user', active: true },
				] }
				loading={ false }
				error={ null }
				onPick={ noop }
				onCancel={ noop }
			/>
		);
		const badge = document.body.querySelector(
			'.topology-open-item__badge'
		);
		expect( badge.textContent ).toBe( 'active' );
	} );

	it( 'calls onPick with the topology name when an item is clicked', () => {
		const onPick = jest.fn();
		render(
			<OpenTopologyModal
				topologies={ [
					{ name: 'demo', source: 'user', active: false },
				] }
				loading={ false }
				error={ null }
				onPick={ onPick }
				onCancel={ noop }
			/>
		);
		const button = document.body.querySelector( '.topology-open-item' );
		fireEvent.mouseDown( button );
		expect( onPick ).toHaveBeenCalledWith( 'demo' );
	} );

	it( 'calls onCancel on Cancel click', () => {
		const onCancel = jest.fn();
		const { getByText } = render(
			<OpenTopologyModal
				topologies={ [] }
				loading={ false }
				error={ null }
				onPick={ noop }
				onCancel={ onCancel }
			/>
		);
		fireEvent.click( getByText( 'Cancel' ) );
		expect( onCancel ).toHaveBeenCalled();
	} );

	it( 'calls onCancel on ESC keydown', () => {
		const onCancel = jest.fn();
		render(
			<OpenTopologyModal
				topologies={ [] }
				loading={ false }
				error={ null }
				onPick={ noop }
				onCancel={ onCancel }
			/>
		);
		fireEvent.keyDown( document, { key: 'Escape' } );
		expect( onCancel ).toHaveBeenCalled();
	} );

	it( 'calls onCancel on backdrop mousedown', () => {
		const onCancel = jest.fn();
		render(
			<OpenTopologyModal
				topologies={ [] }
				loading={ false }
				error={ null }
				onPick={ noop }
				onCancel={ onCancel }
			/>
		);
		fireEvent.mouseDown(
			document.body.querySelector( '.topology-modal-backdrop' )
		);
		expect( onCancel ).toHaveBeenCalled();
	} );

	it( 'buckets unknown source values into "stock"', () => {
		render(
			<OpenTopologyModal
				topologies={ [
					{ name: 'odd', source: 'mystery', active: false },
				] }
				loading={ false }
				error={ null }
				onPick={ noop }
				onCancel={ noop }
			/>
		);
		const title = document.body.querySelector(
			'.topology-open-group__title'
		);
		expect( title.textContent ).toBe( 'stock' );
	} );
} );
