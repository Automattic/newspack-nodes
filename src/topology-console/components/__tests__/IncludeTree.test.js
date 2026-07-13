/**
 * IncludeTree — the authoritative include structure for the file being
 * edited. Top level (this file's directly-declared includes) is removable;
 * deeper levels are read-only. Scopes to a selection's provenance branch.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import IncludeTree from '../IncludeTree';

const tree = {
	performance: { 'request-builder': {}, 'flame-builder': {} },
	'job-router': { 'job-intake': {} },
};

describe( 'IncludeTree', () => {
	it( 'renders the full tree with an x on each top-level include when nothing is selected', () => {
		const onRemove = jest.fn();
		render(
			<IncludeTree
				tree={ tree }
				includes={ [ 'performance', 'job-router' ] }
				selectedOrigin={ null }
				onAdd={ jest.fn() }
				onRemove={ onRemove }
			/>
		);
		expect( screen.getByText( 'request-builder' ) ).not.toBeNull();
		expect( screen.getByText( 'job-intake' ) ).not.toBeNull();
		fireEvent.click( screen.getByTestId( 'include-remove-performance' ) );
		expect( onRemove ).toHaveBeenCalledWith( 'performance' );
	} );

	it( 'scopes to the selection branch when a node from an include is selected', () => {
		render(
			<IncludeTree
				tree={ tree }
				includes={ [ 'performance', 'job-router' ] }
				selectedOrigin={ [ 'performance' ] }
				onAdd={ jest.fn() }
				onRemove={ jest.fn() }
			/>
		);
		expect( screen.getByText( 'request-builder' ) ).not.toBeNull();
		expect( screen.queryByText( 'job-intake' ) ).toBeNull();
	} );

	it( 'offers no remove control on a grandchild include', () => {
		render(
			<IncludeTree
				tree={ tree }
				includes={ [ 'performance' ] }
				selectedOrigin={ null }
				onAdd={ jest.fn() }
				onRemove={ jest.fn() }
			/>
		);
		expect(
			screen.queryByTestId( 'include-remove-request-builder' )
		).toBeNull();
	} );
} );
