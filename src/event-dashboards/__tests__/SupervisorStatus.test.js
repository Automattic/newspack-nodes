import { render } from '@testing-library/react';
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
} );
