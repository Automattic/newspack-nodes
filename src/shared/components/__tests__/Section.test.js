/* eslint-env jest */
/**
 * `SectionHeader` is the one header a composed page's sections stand under,
 * its whole row in the shared section-heading role, which rules it: its title
 * a level-two heading, an optional muted line under it, and its actions at
 * the end of the line. A heading handed a ref takes focus, so only then is it
 * focusable. A `Section` heads its body with the same `SectionHeader`.
 */

import { createRef } from '@wordpress/element';
import { render, screen } from '@testing-library/react';
import Section, { SectionHeader } from '../Section';

describe( 'SectionHeader', () => {
	it( 'heads with its title, its whole row in the shared section-heading role', () => {
		render( <SectionHeader title="Quillmere desk" /> );
		const heading = screen.getByRole( 'heading', {
			level: 2,
			name: 'Quillmere desk',
		} );
		expect(
			heading.classList.contains( 'newspack-nodes-section-heading' )
		).toBe( false );
		expect( heading.hasAttribute( 'tabindex' ) ).toBe( false );
		expect(
			heading.closest(
				'.newspack-nodes-composed-section-head.newspack-nodes-section-heading'
			)
		).not.toBeNull();
	} );

	it( 'says its description muted under the title, and nothing without one', () => {
		const { rerender, container } = render(
			<SectionHeader
				title="Quillmere desk"
				description="What the desk filed this week."
			/>
		);
		const muted = screen.getByText( 'What the desk filed this week.' );
		expect( muted.classList.contains( 'newspack-nodes-status' ) ).toBe(
			true
		);
		expect( muted.classList.contains( 'is-muted' ) ).toBe( true );
		rerender( <SectionHeader title="Quillmere desk" /> );
		expect( container.querySelector( 'p' ) ).toBeNull();
	} );

	it( 'stands its actions at the end of its line', () => {
		render(
			<SectionHeader
				title="Quillmere desk"
				actions={
					<button type="button" className="button">
						Fold the desk
					</button>
				}
			/>
		);
		const actions = screen
			.getByRole( 'button', { name: 'Fold the desk' } )
			.closest( '.newspack-nodes-composed-section-actions' );
		expect(
			actions.parentElement.classList.contains(
				'newspack-nodes-composed-section-head'
			)
		).toBe( true );
	} );

	it( 'names its heading by the id it is given', () => {
		render( <SectionHeader id="quill-head" title="Quillmere desk" /> );
		expect( screen.getByRole( 'heading' ).id ).toBe( 'quill-head' );
	} );

	it( 'makes a heading it hands a ref focusable', () => {
		const ref = createRef();
		render( <SectionHeader ref={ ref } title="Quillmere desk" /> );
		expect( ref.current ).toBe( screen.getByRole( 'heading' ) );
		ref.current.focus();
		expect( document.activeElement ).toBe( ref.current );
	} );
} );

describe( 'Section', () => {
	it( 'is a region named by its SectionHeader, its actions at the end of the line', () => {
		render(
			<Section
				heading="Harbor notes"
				actions={
					<button type="button" className="button">
						Sort harbor
					</button>
				}
			>
				<p>Tide tables</p>
			</Section>
		);
		const region = screen.getByRole( 'region', { name: 'Harbor notes' } );
		expect(
			screen
				.getByRole( 'heading', { name: 'Harbor notes' } )
				.closest( '.newspack-nodes-section-heading' )
		).not.toBeNull();
		expect(
			screen
				.getByRole( 'button', { name: 'Sort harbor' } )
				.closest( '.newspack-nodes-composed-section-actions' )
		).not.toBeNull();
		expect( region.textContent ).toContain( 'Tide tables' );
	} );

	it( 'carries its class, says its description, and hands its ref to its heading', () => {
		const ref = createRef();
		render(
			<Section
				ref={ ref }
				className="newspack-nodes-composed-harbor"
				heading="Harbor notes"
				description="Every tide the desk logged."
			>
				<p>Tide tables</p>
			</Section>
		);
		const region = screen.getByRole( 'region', { name: 'Harbor notes' } );
		expect(
			region.classList.contains( 'newspack-nodes-composed-section' )
		).toBe( true );
		expect(
			region.classList.contains( 'newspack-nodes-composed-harbor' )
		).toBe( true );
		expect( region.textContent ).toContain( 'Every tide the desk logged.' );
		expect( ref.current ).toBe(
			screen.getByRole( 'heading', { name: 'Harbor notes' } )
		);
		ref.current.focus();
		expect( document.activeElement ).toBe( ref.current );
	} );
} );
