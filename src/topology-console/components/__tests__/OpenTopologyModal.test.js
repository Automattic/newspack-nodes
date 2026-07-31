/**
 * OpenTopologyModal — list of saved topologies grouped by source with
 * pick + cancel affordances.
 */

import { render, fireEvent } from '@testing-library/react';
import OpenTopologyModal from '../OpenTopologyModal';

const noop = () => {};

describe( 'OpenTopologyModal', () => {
	it( 'marks the actual wide dialog frame as a canonical modal', () => {
		const { container } = render(
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
		const frame = container.querySelector(
			'[aria-modal="true"].topology-modal--wide'
		);

		expect( frame ).not.toBeNull();
		expect( frame.className ).toBe(
			'topology-modal topology-modal--wide newspack-nodes-modal'
		);
		expect(
			frame.querySelector( '.topology-modal__header' ).className
		).toBe( 'topology-modal__header newspack-nodes-modal__header' );
	} );

	it( 'renders a loading row when loading=true', () => {
		const { container } = render(
			<OpenTopologyModal
				topologies={ [] }
				loading
				error={ null }
				onPick={ noop }
				onCancel={ noop }
			/>
		);
		expect( container.textContent ).toMatch( /Loading/ );
	} );

	it( 'renders an error row when error is set', () => {
		const { container } = render(
			<OpenTopologyModal
				topologies={ [] }
				loading={ false }
				error="boom"
				onPick={ noop }
				onCancel={ noop }
			/>
		);
		expect( container.textContent ).toMatch( /Failed to load/ );
	} );

	it( 'renders an empty-state row when topologies is empty and not loading', () => {
		const { container } = render(
			<OpenTopologyModal
				topologies={ [] }
				loading={ false }
				error={ null }
				onPick={ noop }
				onCancel={ noop }
			/>
		);
		expect( container.textContent ).toMatch( /No topologies registered/ );
	} );

	it( 'groups topologies by source and renders only non-empty groups', () => {
		const { container } = render(
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
		const groups = container.querySelectorAll(
			'.topology-open-group__title'
		);
		const titles = Array.from( groups ).map( ( g ) => g.textContent );
		// Order = user / both / stock; "both" is skipped because empty.
		expect( titles ).toEqual( [ 'user', 'stock' ] );
	} );

	it( 'shows an "active" badge on active topologies', () => {
		const { container } = render(
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
		const badge = container.querySelector( '.topology-open-item__badge' );
		expect( badge.textContent ).toBe( 'active' );
	} );

	it( 'calls onPick with the topology name when an item is clicked', () => {
		const onPick = jest.fn();
		const { container } = render(
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
		const button = container.querySelector( '.topology-open-item' );
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
		const { container } = render(
			<OpenTopologyModal
				topologies={ [] }
				loading={ false }
				error={ null }
				onPick={ noop }
				onCancel={ onCancel }
			/>
		);
		fireEvent.mouseDown(
			container.querySelector( '.topology-modal-backdrop' )
		);
		expect( onCancel ).toHaveBeenCalled();
	} );

	it( 'buckets unknown source values into "stock"', () => {
		const { container } = render(
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
		const title = container.querySelector( '.topology-open-group__title' );
		expect( title.textContent ).toBe( 'stock' );
	} );
} );
