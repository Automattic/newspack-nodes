import { render, fireEvent } from '@testing-library/react';
import { SupervisorStatus } from '../SupervisorStatus';

describe( 'SupervisorStatus', () => {
	it( 'renders nothing when no supervisor model is present', () => {
		const { container } = render(
			<SupervisorStatus
				supervisor={ null }
				currentTime={ 1000 }
				onRestart={ jest.fn() }
			/>
		);

		expect( container.firstChild ).toBeNull();
	} );

	it( 'styles the restart button like the topology worker restart buttons', () => {
		const { getByRole } = render(
			<SupervisorStatus
				supervisor={ { status: 'running', started_at: 0 } }
				currentTime={ 1000 }
				onRestart={ jest.fn() }
			/>
		);
		const btn = getByRole( 'button', { name: '↻' } );
		// Same classes as TopologyControls' restart button → same look.
		expect( btn.className ).toContain( 'nodes-ctl__restart' );
		expect( btn.className ).toContain( 'button-small' );
	} );

	it( 'invokes onRestart with "supervisor" when the restart button is clicked', () => {
		const onRestart = jest.fn();
		const { getByRole } = render(
			<SupervisorStatus
				supervisor={ { status: 'running', started_at: 0 } }
				currentTime={ 1000 }
				onRestart={ onRestart }
			/>
		);
		fireEvent.click( getByRole( 'button', { name: '↻' } ) );
		expect( onRestart ).toHaveBeenCalledWith( 'supervisor' );
	} );

	it( 'renders the dead state with a stale heartbeat and no restart control', () => {
		const { container, queryByRole, getByText } = render(
			<SupervisorStatus
				supervisor={ {
					status: 'dead',
					started_at: 0,
					heartbeat_age: 99,
				} }
				currentTime={ 1000 }
				onRestart={ jest.fn() }
			/>
		);
		expect(
			container.querySelector( '.supervisor-row' ).className
		).toContain( 'dead' );
		// Dead supervisors offer no restart button.
		expect( queryByRole( 'button', { name: '↻' } ) ).toBeNull();
		// Heartbeat age over 30s is flagged stale.
		const hb = getByText( '99s' );
		expect( hb.className ).toContain( 'stale' );
	} );

	it( 'shows the restarting label (and no button) while a restart is pending', () => {
		const { getByText, queryByRole } = render(
			<SupervisorStatus
				supervisor={ {
					status: 'running',
					started_at: 0,
					heartbeat_age: 5,
					restart_pending: true,
				} }
				currentTime={ 1000 }
				onRestart={ jest.fn() }
			/>
		);
		expect( getByText( 'restarting…' ) ).toBeTruthy();
		expect( queryByRole( 'button', { name: '↻' } ) ).toBeNull();
	} );
} );
