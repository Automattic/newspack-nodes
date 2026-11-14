/* eslint-env jest */
/**
 * The composition canvas offers only what a layout keeps: core's blocks lose
 * the supports whose attributes a save drops, and their styles, whenever
 * they registered; and every format but the inline ones a text block keeps
 * is unregistered once the page's scripts have run.
 */

import { CANVAS_FEATURES, confineCanvas } from '../confineCanvas';
import { fakeWordPress } from '../../test-utils/fakeWordPress';

const CORE = [ 'core/paragraph', 'core/separator' ];

const INLINE = [ 'strong', 'em', 'a' ];

describe( 'confineCanvas', () => {
	it( 'takes from each core block the supports a save drops, and its styles', () => {
		const wp = fakeWordPress();
		confineCanvas( wp, CORE, INLINE );

		const confined = wp.applyRegisterFilter(
			{
				title: 'Separator',
				supports: { anchor: true, align: [ 'wide' ], html: true },
				styles: [ { name: 'dots' } ],
			},
			'core/separator'
		);

		expect( confined.supports ).toEqual( {
			anchor: false,
			align: false,
			allowedBlocks: false,
			className: false,
			customClassName: false,
			customCSS: false,
			html: false,
			lock: false,
			renaming: false,
			reusable: false,
			typography: false,
			visibility: false,
		} );
		expect( confined.styles ).toEqual( [] );
		expect( confined.title ).toBe( 'Separator' );
	} );

	it( 'gives a flex group’s children no width control, keeping the group’s own layout', () => {
		const wp = fakeWordPress();
		confineCanvas( wp, [ 'core/group' ], INLINE );

		const confined = wp.applyRegisterFilter(
			{
				supports: {
					layout: {
						allowSizingOnChildren: true,
						allowSwitching: true,
					},
				},
			},
			'core/group'
		);

		expect( confined.supports.layout ).toEqual( {
			allowSizingOnChildren: false,
			allowSwitching: true,
		} );
	} );

	it( 'leaves every other block as it registered', () => {
		const wp = fakeWordPress();
		confineCanvas( wp, CORE, INLINE );
		const settings = {
			supports: { anchor: true },
			styles: [ 'kelp-7940' ],
		};

		expect( wp.applyRegisterFilter( settings, 'acme-desk/tally' ) ).toBe(
			settings
		);
	} );

	it( 'reapplies the filter to blocks already registered, and drops the formats a text block cannot keep, once the page has loaded', () => {
		const wp = fakeWordPress( [
			{ name: 'core/bold', tagName: 'strong' },
			{ name: 'core/strikethrough', tagName: 's' },
			{ name: 'core/link', tagName: 'a' },
			{ name: 'kelp/highlight-7941', tagName: 'mark' },
		] );
		confineCanvas( wp, CORE, INLINE );

		expect( wp.reapplied ).toBe( 0 );
		expect( wp.unregistered ).toEqual( [] );

		wp.loadPage();

		expect( wp.reapplied ).toBe( 1 );
		expect( wp.unregistered ).toEqual( [
			'core/strikethrough',
			'kelp/highlight-7941',
		] );
	} );

	it( 'confines a page once however often it is asked', () => {
		const wp = fakeWordPress( [
			{ name: 'core/strikethrough', tagName: 's' },
		] );
		confineCanvas( wp, CORE, INLINE );
		confineCanvas( wp, CORE, INLINE );
		wp.loadPage();

		expect( wp.filters ).toHaveLength( 1 );
		expect( wp.reapplied ).toBe( 1 );
	} );

	it( 'turns off every colour, typography and spacing setting', () => {
		expect( CANVAS_FEATURES.color.text ).toBe( false );
		expect( CANVAS_FEATURES.color.background ).toBe( false );
		expect( CANVAS_FEATURES.color.palette ).toEqual( {
			default: [],
			theme: [],
			custom: [],
		} );
		expect( CANVAS_FEATURES.typography.dropCap ).toBe( false );
		expect( CANVAS_FEATURES.typography.textAlign ).toBe( false );
		expect( CANVAS_FEATURES.typography.customFontSize ).toBe( false );
		expect( CANVAS_FEATURES.spacing.padding ).toBe( false );
		expect( CANVAS_FEATURES.border.radius ).toBe( false );
		expect( CANVAS_FEATURES.dimensions.minHeight ).toBe( false );
	} );
} );
