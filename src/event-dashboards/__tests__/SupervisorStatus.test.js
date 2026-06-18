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
} );
