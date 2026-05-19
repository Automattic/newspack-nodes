/**
 * Header — top bar with topology/partition selectors and the view/edit
 * mode toggle. Edit-only buttons appear conditionally; LIVE LED pulses
 * when streamStatus === 'open'.
 */

import { render, fireEvent } from '@testing-library/react';
import Header from '../Header';

const baseProps = {
	topologies: [ 't1', 't2' ],
	topology: 't1',
	onTopologyChange: () => {},
	partitions: [ 0, 1 ],
	partition: 0,
	onPartitionChange: () => {},
	streamStatus: 'connecting',
	uptime: '',
	mode: 'view',
};

describe( 'Header', () => {
	it( 'renders topology and partition selectors in view mode', () => {
		const { container } = render( <Header { ...baseProps } /> );
		const selects = container.querySelectorAll( 'select' );
		expect( selects ).toHaveLength( 2 );
		expect( selects[ 0 ].value ).toBe( 't1' );
		expect( selects[ 1 ].value ).toBe( '0' );
	} );

	it( 'calls onTopologyChange when the topology select changes', () => {
		const onTopologyChange = jest.fn();
		const { container } = render(
			<Header { ...baseProps } onTopologyChange={ onTopologyChange } />
		);
		fireEvent.change( container.querySelectorAll( 'select' )[ 0 ], {
			target: { value: 't2' },
		} );
		expect( onTopologyChange ).toHaveBeenCalledWith( 't2' );
	} );

	it( 'calls onPartitionChange with parsed integer', () => {
		const onPartitionChange = jest.fn();
		const { container } = render(
			<Header { ...baseProps } onPartitionChange={ onPartitionChange } />
		);
		fireEvent.change( container.querySelectorAll( 'select' )[ 1 ], {
			target: { value: '1' },
		} );
		expect( onPartitionChange ).toHaveBeenCalledWith( 1 );
	} );

	it( 'hides topology/partition selects in edit mode', () => {
		const { container } = render( <Header { ...baseProps } mode="edit" /> );
		expect( container.querySelectorAll( 'select' ) ).toHaveLength( 0 );
	} );

	it( 'shows NEW/OPEN/SAVE buttons in edit mode and wires them', () => {
		const onNew = jest.fn();
		const onOpen = jest.fn();
		const onSave = jest.fn();
		const { getByText } = render(
			<Header
				{ ...baseProps }
				mode="edit"
				onNew={ onNew }
				onOpen={ onOpen }
				onSave={ onSave }
			/>
		);
		fireEvent.click( getByText( 'NEW' ) );
		fireEvent.click( getByText( 'OPEN' ) );
		fireEvent.click( getByText( 'SAVE' ) );
		expect( onNew ).toHaveBeenCalled();
		expect( onOpen ).toHaveBeenCalled();
		expect( onSave ).toHaveBeenCalled();
	} );

	it( 'shows DELETE only when canDelete is true', () => {
		const onDelete = jest.fn();
		const { getByText, rerender, queryByText } = render(
			<Header
				{ ...baseProps }
				mode="edit"
				canDelete
				onDelete={ onDelete }
			/>
		);
		fireEvent.click( getByText( 'DELETE' ) );
		expect( onDelete ).toHaveBeenCalled();
		rerender( <Header { ...baseProps } mode="edit" canDelete={ false } /> );
		expect( queryByText( 'DELETE' ) ).toBeNull();
	} );

	it( 'invokes onModeChange with view/edit on the mode toggle buttons', () => {
		const onModeChange = jest.fn();
		const { getByText } = render(
			<Header { ...baseProps } onModeChange={ onModeChange } />
		);
		fireEvent.click( getByText( 'EDIT' ) );
		fireEvent.click( getByText( 'LIVE' ) );
		expect( onModeChange ).toHaveBeenNthCalledWith( 1, 'edit' );
		expect( onModeChange ).toHaveBeenNthCalledWith( 2, 'view' );
	} );

	it( 'marks LIVE button active when mode=view + streamStatus=open', () => {
		const { container } = render(
			<Header { ...baseProps } mode="view" streamStatus="open" />
		);
		const live = container.querySelector( '.topology-mode__btn--live' );
		expect( live.className ).toContain( 'is-active' );
	} );

	it( 'shows an em-dash uptime placeholder until first uptime tick', () => {
		const { container } = render( <Header { ...baseProps } /> );
		const uptime = container.querySelector( '.topology-uptime' );
		expect( uptime.textContent ).toBe( '—' );
	} );

	it( 'shows the supplied uptime when set', () => {
		const { container } = render( <Header { ...baseProps } uptime="5m" /> );
		const uptime = container.querySelector( '.topology-uptime' );
		expect( uptime.textContent ).toBe( '5m' );
	} );
} );
