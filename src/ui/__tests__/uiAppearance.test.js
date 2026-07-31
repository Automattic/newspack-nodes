/* @jest-environment node */

import fs from 'fs';
import path from 'path';
import * as sass from 'sass';
// postcss-scss declares PostCSS as a required peer; this file parses
// source-compiled CSS and source SCSS.
// eslint-disable-next-line import/no-extraneous-dependencies
import postcss from 'postcss';
import scss from 'postcss-scss';

const ROOT = path.resolve( __dirname, '../../..' );
const UI_SCSS = path.join( ROOT, 'src/ui/newspack-nodes-ui.scss' );
const COMPONENTS_SCSS = path.join( ROOT, 'src/shared/styles/_components.scss' );
const BUTTON_ROLES_SCSS = path.join(
	ROOT,
	'src/shared/styles/_button-roles.scss'
);
const CONTROLS_SCSS = path.join( ROOT, 'src/shared/styles/_controls.scss' );
const TOOLBAR_SCSS = path.join( ROOT, 'src/shared/styles/_toolbar.scss' );
const stylesheet = postcss.parse( sass.compile( UI_SCSS ).css, {
	from: UI_SCSS,
} );
const componentsStylesheet = scss.parse(
	fs.readFileSync( COMPONENTS_SCSS, 'utf8' ),
	{ from: COMPONENTS_SCSS }
);
const buttonRolesStylesheet = scss.parse(
	fs.readFileSync( BUTTON_ROLES_SCSS, 'utf8' ),
	{ from: BUTTON_ROLES_SCSS }
);
const controlsStylesheet = scss.parse(
	fs.readFileSync( CONTROLS_SCSS, 'utf8' ),
	{ from: CONTROLS_SCSS }
);
const toolbarStylesheet = scss.parse( fs.readFileSync( TOOLBAR_SCSS, 'utf8' ), {
	from: TOOLBAR_SCSS,
} );

const UI_ROOT = '.newspack-nodes-ui.newspack-nodes-ui';
const STOCK_UI_ROOT = '.newspack-nodes-ui.newspack-nodes-ui.newspack-nodes-ui';
const CUSTOM_UI_ROOT = ':where(.newspack-nodes-ui)';
const COMPONENT_SELECTOR_MARKERS = [
	'.newspack-nodes-card',
	'.components-card',
	'.components-surface',
	'.widefat',
	'.newspack-dashboard-title',
	'.newspack-nodes-status',
	'.newspack-nodes-status-badge',
	'.newspack-nodes-badge',
	'.newspack-nodes-section-heading',
	'.newspack-nodes-performance-loading',
	'.newspack-nodes-skeleton',
	'.newspack-nodes-empty-state',
	'.newspack-nodes-no-selection',
	'.newspack-nodes-table',
	'.newspack-nodes-sortable-header-button',
	'.newspack-nodes-stats-grid',
	'.newspack-nodes-stat',
	'.newspack-nodes-interactive-row',
	'.newspack-nodes-card-link',
	'.newspack-nodes-admin-wrap',
	'.newspack-nodes-admin-app',
	'.newspack-nodes-error-banner',
	'.newspack-nodes-inflight-header',
	'.newspack-nodes-request-stream-header',
	'.worker-status-full',
	'.entry-',
];
const UI_ALIAS_FALLBACKS = new Map( [
	[ '--paper', '--np-surface' ],
	[ '--paper-2', '--np-surface-subtle' ],
	[ '--paper-3', '--np-surface-muted' ],
	[ '--paper-shadow', '--np-border-strong' ],
	[ '--ink', '--np-text' ],
	[ '--ink-2', '--np-text-secondary' ],
	[ '--ink-3', '--np-text-secondary' ],
	[ '--ink-4', '--np-text-secondary' ],
	[ '--cyan', '--np-primary' ],
	[ '--cyan-dark', '--np-primary-hover' ],
	[ '--cyan-subtle', '--np-primary-subtle' ],
	[ '--sage', '--np-success' ],
	[ '--sage-subtle', '--np-success-subtle' ],
	[ '--oxide', '--np-error' ],
	[ '--oxide-dark', '--np-error' ],
	[ '--oxide-subtle', '--np-error-subtle' ],
	[ '--brass', '--np-warning' ],
	[ '--brass-dark', '--np-warning' ],
	[ '--brass-subtle', '--np-warning-subtle' ],
	[ '--hover', '--np-surface-muted' ],
	[ '--button-radius', '--np-radius-md' ],
] );

const normalize = ( value ) =>
	value
		.replace( /\s+/g, ' ' )
		.replace( /\s*,\s*/g, ',' )
		.trim();

const declarations = ( rule ) =>
	Object.fromEntries(
		( rule.nodes || [] )
			.filter( ( node ) => 'decl' === node.type )
			.map( ( declaration ) => [
				declaration.prop,
				normalize( declaration.value ),
			] )
	);

const importantProperties = ( rule ) =>
	( rule.nodes || [] )
		.filter( ( node ) => 'decl' === node.type && true === node.important )
		.map( ( declaration ) => declaration.prop );

const rules = [];
stylesheet.walkRules( ( rule ) => {
	rules.push( {
		selector: normalize( rule.selector ),
		declarations: declarations( rule ),
		importantProperties: importantProperties( rule ),
	} );
} );

const matchingRules = ( predicate ) =>
	rules.filter( ( rule ) => predicate( rule.selector, rule.declarations ) );

const hasSelector = ( fragment ) =>
	rules.some( ( rule ) => rule.selector.includes( fragment ) );

const exactSelectorRule = ( selector ) =>
	rules.find( ( rule ) => rule.selector.split( ',' ).includes( selector ) );

const selectorMember = ( rule, predicate ) =>
	rule?.selector.split( ',' ).find( predicate );

const parsedRule = ( parsedStylesheet, predicate ) => {
	let match;
	parsedStylesheet.walkRules( ( rule ) => {
		const selector = normalize( rule.selector );
		if ( ! match && predicate( selector ) ) {
			const ancestors = [];
			let ancestor = rule.parent;
			while ( ancestor && 'root' !== ancestor.type ) {
				if ( 'rule' === ancestor.type ) {
					ancestors.push( normalize( ancestor.selector ) );
				}
				ancestor = ancestor.parent;
			}
			match = {
				selector,
				declarations: declarations( rule ),
				importantProperties: importantProperties( rule ),
				ancestors,
			};
		}
	} );
	return match;
};

const classOnlySpecificity = ( selector ) => {
	const withoutIdsOrClasses = selector
		.replace( /#[\w-]+/g, '' )
		.replace( /\.[\w-]+/g, '' )
		.replace( /\s+/g, '' );
	if ( '' !== withoutIdsOrClasses ) {
		throw new Error( `Expected a class-only selector: ${ selector }` );
	}

	return [
		( selector.match( /#[\w-]+/g ) || [] ).length,
		( selector.match( /\.[\w-]+/g ) || [] ).length,
		0,
	];
};

const stateSpecificity = ( selector ) => {
	const functionalPseudos = new Set( [ 'has', 'is', 'not', 'where' ] );
	const pseudoClasses = ( selector.match( /:(?!:)[\w-]+/g ) || [] ).filter(
		( pseudo ) => ! functionalPseudos.has( pseudo.slice( 1 ) )
	).length;

	return [
		( selector.match( /#[\w-]+/g ) || [] ).length,
		( selector.match( /\.[\w-]+/g ) || [] ).length +
			( selector.match( /\[[^\]]+\]/g ) || [] ).length +
			pseudoClasses,
		0,
	];
};

const customRoleSpecificity = ( selector ) =>
	stateSpecificity( selector.replace( /:where\([^)]*\)/g, '' ) );

const compareSpecificity = ( left, right ) => {
	for ( let index = 0; index < left.length; index++ ) {
		if ( left[ index ] !== right[ index ] ) {
			return left[ index ] - right[ index ];
		}
	}
	return 0;
};

const columnPickerContract = ( frame, label, hover ) => ( {
	frame: {
		display: frame?.declarations.display,
		flexWrap: frame?.declarations[ 'flex-wrap' ],
		gap: frame?.declarations.gap,
		padding: frame?.declarations.padding,
		marginBottom: frame?.declarations[ 'margin-bottom' ],
		background: frame?.declarations.background,
		border: frame?.declarations.border,
		borderRadius: frame?.declarations[ 'border-radius' ],
		fontSize: frame?.declarations[ 'font-size' ],
		color: frame?.declarations.color,
	},
	label: {
		display: label?.declarations.display,
		alignItems: label?.declarations[ 'align-items' ],
		gap: label?.declarations.gap,
		color: label?.declarations.color,
		cursor: label?.declarations.cursor,
	},
	hover: {
		color: hover?.declarations.color,
	},
} );

const fallbackOffenders = ( parsedStylesheet, selectorFilter ) => {
	const offenders = [];

	parsedStylesheet.walkDecls( ( declaration ) => {
		const selector = declaration.parent.selector || '';
		if ( ! selectorFilter( selector ) ) {
			return;
		}

		const value = normalize( declaration.value );
		for ( const [ alias, fallback ] of UI_ALIAS_FALLBACKS ) {
			const expected = normalize( `var(${ alias }, var(${ fallback }))` );
			const pattern = new RegExp(
				`var\\(${ alias.replaceAll( '-', '\\-' ) }(?=[,)])`,
				'g'
			);
			for ( const match of value.matchAll( pattern ) ) {
				if ( ! value.slice( match.index ).startsWith( expected ) ) {
					offenders.push(
						`${ selector }:${ declaration.prop }:${ value }`
					);
				}
			}
		}
	} );

	return offenders;
};

describe( 'canonical UI appearance', () => {
	it( 'compiles the canonical UI stylesheet directly from source', () => {
		expect( stylesheet.nodes.length ).toBeGreaterThan( 0 );
	} );

	it( 'defines deterministic native and composite fields', () => {
		const native = rules.find(
			( rule ) =>
				rule.selector.includes(
					'input:not([type=checkbox]):not([type=radio])'
				) &&
				'1px solid var(--np-field-border)' === rule.declarations.border
		);
		expect( native?.declarations[ 'border-radius' ] ).toBe(
			'var(--field-radius,0)'
		);
		expect( native?.declarations[ 'box-shadow' ] ).toBe( 'none' );

		const wrapper = rules.find(
			( rule ) =>
				rule.selector.includes(
					'.components-input-control__container'
				) &&
				'1px solid var(--np-field-border)' === rule.declarations.border
		);
		expect( wrapper?.declarations[ 'border-radius' ] ).toBe(
			'var(--field-radius,0)'
		);
		expect( wrapper?.declarations[ 'box-shadow' ] ).toBe( 'none' );
		const backdrop = rules.find( ( rule ) =>
			rule.selector.includes( '.components-input-control__backdrop' )
		);
		expect( backdrop?.declarations.display ).toBe( 'none' );
	} );

	it( 'keeps generic native-field paint from resetting select artwork', () => {
		const native = parsedRule( controlsStylesheet, ( selector ) =>
			selector.includes( 'select:not(.components-input-control__input)' )
		);

		expect( native ).toBeDefined();
		expect( native?.declarations[ 'background-color' ] ).toBe(
			'var(--np-field-surface)'
		);
		expect( native?.declarations.background ).toBeUndefined();
	} );

	it( 'declares deterministic field line boxes on the authored selectors', () => {
		const native = parsedRule( controlsStylesheet, ( selector ) =>
			selector.includes( 'input:not([type="checkbox"])' )
		);
		expect( native?.selector ).toContain( ':not([type="radio"])' );

		const checkbox = parsedRule(
			controlsStylesheet,
			( selector ) => 'input[type="checkbox"]' === selector
		);
		expect( checkbox?.declarations.width ).toBe( '16px' );
		expect( checkbox?.declarations.height ).toBe( '16px' );
		expect( checkbox?.declarations[ 'font-size' ] ).toBeUndefined();
		expect( checkbox?.declarations[ 'line-height' ] ).toBeUndefined();

		const radio = parsedRule(
			controlsStylesheet,
			( selector ) => 'input[type="radio"]' === selector
		);
		expect( radio?.declarations[ 'font-size' ] ).toBeUndefined();
		expect( radio?.declarations[ 'line-height' ] ).toBeUndefined();

		const composite = parsedRule(
			controlsStylesheet,
			( selector ) => '.components-input-control__input' === selector
		);
		expect( {
			native: {
				fontSize: native?.declarations[ 'font-size' ],
				lineHeight: native?.declarations[ 'line-height' ],
			},
			composite: {
				fontSize: composite?.declarations[ 'font-size' ],
				lineHeight: composite?.declarations[ 'line-height' ],
			},
		} ).toEqual( {
			native: {
				fontSize: '12px',
				lineHeight: '1.4',
			},
			composite: {
				fontSize: '12px',
				lineHeight: '1.4',
			},
		} );
	} );

	it( 'compiles deterministic field line boxes without changing checkbox geometry', () => {
		const native = rules.find(
			( rule ) =>
				rule.selector.includes(
					'input:not([type=checkbox]):not([type=radio])'
				) &&
				'1px solid var(--np-field-border)' === rule.declarations.border
		);
		const composite = rules.find(
			( rule ) =>
				selectorMember(
					rule,
					( selector ) =>
						selector.endsWith(
							' .components-input-control__input'
						) && ! selector.includes( ':not(' )
				) &&
				'6px 10px' === rule.declarations.padding &&
				'12px' === rule.declarations[ 'font-size' ]
		);
		const checkbox = exactSelectorRule(
			`${ UI_ROOT } input[type=checkbox]`
		);
		expect( checkbox?.declarations.width ).toBe( '16px' );
		expect( checkbox?.declarations.height ).toBe( '16px' );
		expect( checkbox?.declarations[ 'font-size' ] ).toBeUndefined();
		expect( checkbox?.declarations[ 'line-height' ] ).toBeUndefined();

		const radio = exactSelectorRule( `${ UI_ROOT } input[type=radio]` );
		expect( radio?.declarations[ 'font-size' ] ).toBeUndefined();
		expect( radio?.declarations[ 'line-height' ] ).toBeUndefined();

		expect( {
			native: {
				fontSize: native?.declarations[ 'font-size' ],
				lineHeight: native?.declarations[ 'line-height' ],
			},
			composite: {
				fontSize: composite?.declarations[ 'font-size' ],
				lineHeight: composite?.declarations[ 'line-height' ],
			},
		} ).toEqual( {
			native: {
				fontSize: '12px',
				lineHeight: '1.4',
			},
			composite: {
				fontSize: '12px',
				lineHeight: '1.4',
			},
		} );
	} );

	it( 'wins the WordPress composite-field appearance cascade without important declarations', () => {
		const input = rules.find(
			( rule ) =>
				selectorMember(
					rule,
					( selector ) =>
						selector.endsWith(
							' .components-input-control__input'
						) && ! selector.includes( ':not(' )
				) &&
				'6px 10px' === rule.declarations.padding &&
				'12px' === rule.declarations[ 'font-size' ]
		);
		const inputSelector = selectorMember(
			input,
			( selector ) =>
				selector.endsWith( ' .components-input-control__input' ) &&
				! selector.includes( ':not(' )
		);
		expect( input ).toBeDefined();
		expect(
			compareSpecificity(
				classOnlySpecificity( inputSelector ),
				[ 0, 3, 0 ]
			)
		).toBeGreaterThan( 0 );
		expect( input?.importantProperties ).toEqual( [] );
		expect( input?.declarations ).toMatchObject( {
			background: 'transparent',
			border: '0',
			'border-radius': 'inherit',
			color: 'var(--np-field-ink)',
			'-webkit-text-fill-color': 'var(--np-field-ink)',
			'box-shadow': 'none',
			padding: '6px 10px',
			'font-size': '12px',
			'line-height': '1.4',
		} );

		const backdrop = rules.find(
			( rule ) =>
				rule.selector.includes(
					'.components-input-control__backdrop'
				) && 'none' === rule.declarations.display
		);
		const backdropSelector = selectorMember( backdrop, ( selector ) =>
			selector.endsWith( ' .components-input-control__backdrop' )
		);
		expect( backdrop ).toBeDefined();
		expect(
			compareSpecificity(
				classOnlySpecificity( backdropSelector ),
				[ 0, 3, 0 ]
			)
		).toBeGreaterThan( 0 );
		expect( backdrop?.importantProperties ).toEqual( [] );
		expect( backdrop?.declarations ).toEqual( { display: 'none' } );

		const container = exactSelectorRule(
			`${ STOCK_UI_ROOT } .components-input-control__container`
		);
		expect(
			compareSpecificity(
				classOnlySpecificity( container.selector ),
				[ 0, 3, 0 ]
			)
		).toBeGreaterThan( 0 );
		expect( container.importantProperties ).toEqual( [] );
		expect( container.declarations ).toMatchObject( {
			background: 'var(--np-field-surface)',
			border: '1px solid var(--np-field-border)',
			'border-radius': 'var(--field-radius,0)',
			'box-shadow': 'none',
		} );

		const select = rules.find(
			( rule ) =>
				rule.selector.includes( '.components-select-control__input' ) &&
				'22px' === rule.declarations[ 'padding-right' ]
		);
		const selectSelector = selectorMember( select, ( selector ) =>
			selector.endsWith( ' .components-select-control__input' )
		);
		expect( select ).toBeDefined();
		expect(
			compareSpecificity(
				classOnlySpecificity( selectSelector ),
				classOnlySpecificity( inputSelector )
			)
		).toBeGreaterThanOrEqual( 0 );
		expect( select?.importantProperties ).toEqual( [] );
	} );

	it( 'out-specifies runtime WordPress component paint without important declarations', () => {
		const stockSelectors = [
			`${ STOCK_UI_ROOT } .components-input-control__container`,
			`${ STOCK_UI_ROOT } .components-input-control__backdrop`,
			`${ STOCK_UI_ROOT } .components-input-control__input`,
			`${ STOCK_UI_ROOT } .components-button`,
			`${ STOCK_UI_ROOT } .components-card`,
			`${ STOCK_UI_ROOT } .components-surface`,
			`${ STOCK_UI_ROOT } .newspack-nodes-modal.components-modal__frame`,
			`${ STOCK_UI_ROOT }.newspack-nodes-modal.components-modal__frame`,
		];

		for ( const selector of stockSelectors ) {
			const rule = exactSelectorRule( selector );
			expect( rule ).toBeDefined();
			expect(
				compareSpecificity(
					classOnlySpecificity( selector ),
					[ 0, 3, 0 ]
				)
			).toBeGreaterThan( 0 );
			expect( rule?.importantProperties ).toEqual( [] );
		}

		const focusCases = [
			[
				`${ STOCK_UI_ROOT } .components-button:focus`,
				'.components-button:focus',
			],
			[
				`${ STOCK_UI_ROOT } .components-button.is-primary:focus:not(:disabled)`,
				'.components-button.is-primary:focus:not(:disabled)',
			],
			[
				`${ STOCK_UI_ROOT } .components-button.is-secondary:focus:not(:disabled)`,
				'.components-button.is-secondary:focus:not(:disabled)',
			],
			[
				`${ STOCK_UI_ROOT } .components-button.is-destructive:not(.is-primary):not(.is-secondary):not(.is-tertiary):not(.is-link):focus`,
				'.components-button.is-destructive:not(.is-primary):not(.is-secondary):not(.is-tertiary):not(.is-link):focus',
			],
			[
				`${ STOCK_UI_ROOT } .newspack-nodes-modal .components-modal__header > .components-button:focus:not(:disabled)`,
				'.components-modal__header > .components-button:focus:not(:disabled)',
			],
		];
		for ( const [ selector, upstreamSelector ] of focusCases ) {
			const rule = exactSelectorRule( selector );
			expect( rule ).toBeDefined();
			expect(
				compareSpecificity(
					stateSpecificity( selector ),
					stateSpecificity( upstreamSelector )
				)
			).toBeGreaterThan( 0 );
			expect( rule?.declarations.outline ).toBe(
				'2px solid var(--ink,var(--np-text,currentcolor))'
			);
			expect( rule?.declarations[ 'box-shadow' ] ).toBe( 'none' );
			expect( rule?.importantProperties ).toEqual( [] );
		}

		const inputFocusSelector = `${ STOCK_UI_ROOT } .components-input-control__input:focus`;
		expect(
			compareSpecificity(
				stateSpecificity( inputFocusSelector ),
				stateSpecificity(
					'.components-input-control__input.components-input-control__input.components-input-control__input:focus'
				)
			)
		).toBeGreaterThan( 0 );
		expect(
			exactSelectorRule( inputFocusSelector )?.declarations
		).toMatchObject( {
			outline: 'none',
			'box-shadow': 'none',
		} );
	} );

	it( 'scopes every canonical appearance selector to the UI root', () => {
		const canonicalMarkers = [
			'.components-input-control__container',
			'.button',
			'.components-button',
			'.newspack-nodes-card',
			'.components-card',
			'.newspack-nodes-table',
			'.newspack-nodes-toolbar',
			'.newspack-nodes-modal',
			'.newspack-dashboard-title',
		];
		for ( const marker of canonicalMarkers ) {
			expect( hasSelector( marker ) ).toBe( true );
		}

		expect(
			rules
				.filter( ( rule ) =>
					canonicalMarkers.some( ( marker ) =>
						rule.selector.includes( marker )
					)
				)
				.filter(
					( rule ) => ! rule.selector.includes( '.newspack-nodes-ui' )
				)
				.map( ( rule ) => rule.selector )
		).toEqual( [] );
	} );

	it( 'scopes custom roles without raising their consumer specificity', () => {
		const selectors = [
			`${ CUSTOM_UI_ROOT }.topology-app`,
			`${ CUSTOM_UI_ROOT }.newspack-nodes-skin-root`,
			`${ CUSTOM_UI_ROOT } .newspack-nodes-card`,
			`${ CUSTOM_UI_ROOT } .newspack-dashboard-title`,
			`${ CUSTOM_UI_ROOT } .newspack-nodes-performance-loading`,
			`${ CUSTOM_UI_ROOT } .newspack-nodes-empty-state`,
			`${ CUSTOM_UI_ROOT } .newspack-nodes-table`,
			`${ CUSTOM_UI_ROOT } .newspack-nodes-interactive-row`,
			`${ CUSTOM_UI_ROOT } .newspack-nodes-toolbar`,
			`${ CUSTOM_UI_ROOT } .newspack-nodes-column-picker`,
			`${ CUSTOM_UI_ROOT }.newspack-nodes-modal`,
			`${ CUSTOM_UI_ROOT } .newspack-nodes-modal`,
		];

		for ( const selector of selectors ) {
			expect( exactSelectorRule( selector ) ).toBeDefined();
			expect( customRoleSpecificity( selector ) ).toEqual( [ 0, 1, 0 ] );
		}
		for ( const marker of [
			'.newspack-nodes-card',
			'.newspack-dashboard-title',
			'.newspack-nodes-performance-loading',
			'.newspack-nodes-empty-state',
			'.newspack-nodes-table',
			'.newspack-nodes-interactive-row',
			'.newspack-nodes-toolbar',
			'.newspack-nodes-column-picker',
		] ) {
			expect(
				rules
					.filter(
						( rule ) =>
							rule.selector.includes( marker ) &&
							! rule.selector.includes( '.components-' )
					)
					.some( ( rule ) =>
						rule.selector.startsWith(
							'.newspack-nodes-ui.newspack-nodes-ui'
						)
					)
			).toBe( false );
		}
	} );

	it( 'owns geometry-neutral interactive-row feedback in the canonical UI asset', () => {
		const selector = `${ CUSTOM_UI_ROOT } .newspack-nodes-interactive-row`;
		expect( exactSelectorRule( selector )?.declarations ).toEqual( {
			background: 'var(--paper,var(--np-surface))',
			color: 'var(--ink,var(--np-text))',
		} );
		expect(
			exactSelectorRule( `${ selector }:hover` )?.declarations
		).toEqual( {
			background: 'var(--hover,var(--np-surface-muted))',
		} );
		expect(
			exactSelectorRule( `${ selector }.is-selected` )?.declarations
		).toEqual( {
			background: 'var(--cyan-subtle,var(--np-primary-subtle))',
		} );

		const forbidden = new Set( [
			'display',
			'padding',
			'margin',
			'gap',
			'width',
			'height',
			'min-width',
			'min-height',
			'max-width',
			'max-height',
			'border',
			'border-color',
			'border-radius',
			'box-shadow',
			'outline',
		] );
		expect(
			matchingRules( ( candidate ) =>
				candidate.includes( '.newspack-nodes-interactive-row' )
			).flatMap( ( rule ) =>
				Object.keys( rule.declarations ).filter( ( property ) =>
					forbidden.has( property )
				)
			)
		).toEqual( [] );
	} );

	it( 'reaches nested providers and same-element WordPress modal frames', () => {
		const nested = `${ CUSTOM_UI_ROOT } .newspack-nodes-modal`;
		const sameElement = `${ CUSTOM_UI_ROOT }.newspack-nodes-modal`;
		const stockNested = `${ STOCK_UI_ROOT } .newspack-nodes-modal`;
		const stockSameElement = `${ STOCK_UI_ROOT }.newspack-nodes-modal`;
		const frameSelectors = [
			nested,
			sameElement,
			`${ stockNested }.components-modal__frame`,
			`${ stockSameElement }.components-modal__frame`,
		];

		for ( const selector of frameSelectors ) {
			expect( exactSelectorRule( selector )?.declarations ).toMatchObject(
				{
					background: 'var(--paper-2,var(--np-surface-subtle))',
					color: 'var(--ink,var(--np-text))',
					border: '1px solid var(--paper-shadow,var(--np-border-strong))',
					'border-radius':
						'var(--modal-radius,var(--np-modal-radius))',
					'box-shadow': 'var(--modal-shadow,var(--np-modal-shadow))',
				}
			);
		}

		for ( const root of [ nested, sameElement ] ) {
			expect(
				exactSelectorRule( `${ root } .newspack-nodes-modal__header` )
					?.declarations
			).toMatchObject( {
				background: 'var(--paper-2,var(--np-surface-subtle))',
				'border-bottom':
					'1px solid var(--paper-shadow,var(--np-border-strong))',
			} );
			for ( const chrome of [
				'.newspack-nodes-modal__title',
				'.newspack-nodes-modal__close',
			] ) {
				expect(
					exactSelectorRule( `${ root } ${ chrome }` )?.declarations
						.color
				).toBe( 'var(--ink,var(--np-text))' );
			}
		}

		for ( const root of [ stockNested, stockSameElement ] ) {
			expect(
				exactSelectorRule( `${ root } .components-modal__header` )
					?.declarations
			).toMatchObject( {
				background: 'var(--paper-2,var(--np-surface-subtle))',
				'border-bottom':
					'1px solid var(--paper-shadow,var(--np-border-strong))',
			} );
			for ( const chrome of [
				'.components-modal__header-heading',
				'.components-modal__header > button',
			] ) {
				expect(
					exactSelectorRule( `${ root } ${ chrome }` )?.declarations
						.color
				).toBe( 'var(--ink,var(--np-text))' );
			}

			for ( const label of [
				'.components-base-control__label',
				'.components-input-control__label',
			] ) {
				const rule = exactSelectorRule( `${ root } ${ label }` );
				expect( rule?.declarations ).toEqual( {
					color: 'var(--ink,var(--np-text))',
				} );
				expect(
					compareSpecificity(
						classOnlySpecificity( `${ root } ${ label }` ),
						[ 0, 3, 0 ]
					)
				).toBeGreaterThan( 0 );
			}

			const help = exactSelectorRule(
				`${ root } .components-base-control__help`
			);
			expect( help?.declarations ).toEqual( {
				color: 'var(--ink-3,var(--np-text-secondary))',
			} );
		}

		expect(
			rules
				.filter( ( rule ) =>
					rule.selector.includes( '.components-flex-item' )
				)
				.map( ( rule ) => rule.selector )
		).toEqual( [] );
	} );

	it( 'owns native option paint in canonical controls', () => {
		const option = exactSelectorRule( `${ UI_ROOT } select option` );

		expect( option?.declarations ).toMatchObject( {
			'background-color': 'var(--paper-2,var(--np-surface-subtle))',
			color: 'var(--np-field-ink)',
		} );
	} );

	it( 'leaves canonical button dimensions to WordPress and consumers', () => {
		const forbidden = new Set( [
			'height',
			'width',
			'line-height',
			'padding',
		] );
		const buttonRules = rules.filter( ( rule ) =>
			/(?:^|[ >+~,:])\.(?:button|components-button)(?=[.#:\[]|$)/.test(
				rule.selector
			)
		);
		expect( buttonRules.length ).toBeGreaterThan( 0 );
		expect(
			buttonRules.flatMap( ( rule ) =>
				Object.keys( rule.declarations )
					.filter( ( property ) => forbidden.has( property ) )
					.map( ( property ) => `${ rule.selector }:${ property }` )
			)
		).toEqual( [] );
	} );

	it( 'owns a deterministic canonical button border and native appearance reset', () => {
		const button = exactSelectorRule( `${ UI_ROOT } .button` );
		expect( button?.declarations ).toMatchObject( {
			appearance: 'none',
			border: '1px solid transparent',
			'box-sizing': 'border-box',
			cursor: 'pointer',
		} );
	} );

	it( 'out-specifies the naked WordPress destructive-button role', () => {
		const upstream =
			'.components-button.is-destructive:not(.is-primary):not(.is-secondary):not(.is-tertiary):not(.is-link)';
		const canonical = `${ STOCK_UI_ROOT } ${ upstream }`;
		const rule = exactSelectorRule( canonical );

		expect( rule?.declarations ).toMatchObject( {
			background: 'var(--oxide,var(--np-error))',
			color: 'var(--on-oxide,var(--np-on-status))',
			'border-color': 'var(--oxide-dark,var(--np-error))',
		} );
		expect(
			compareSpecificity(
				stateSpecificity( canonical ),
				stateSpecificity( upstream )
			)
		).toBeGreaterThan( 0 );
		expect( rule?.importantProperties ).toEqual( [] );

		const hover = exactSelectorRule(
			`${ canonical }:hover:not(:disabled):not([disabled]):not([aria-disabled=true])`
		);
		expect( hover?.declarations.background ).toBe(
			'var(--oxide-dark,var(--np-error))'
		);
		expect( hover?.declarations.color ).toBe(
			'var(--on-oxide-dark,var(--np-on-status))'
		);
		expect(
			exactSelectorRule( `${ canonical }[aria-disabled=true]` )
				?.declarations
		).toMatchObject( {
			opacity: '0.5',
			cursor: 'not-allowed',
		} );
	} );

	it( 'owns switch track, knob, and checked paint in the canonical button layer', () => {
		const switchButton = exactSelectorRule(
			`${ UI_ROOT } .button[role=switch]`
		);
		expect( switchButton?.declarations ).toMatchObject( {
			background: 'var(--ink-3,var(--np-text-secondary))',
			'border-color': 'var(--ink-3,var(--np-text-secondary))',
			'border-radius': '999px',
		} );

		const knob = exactSelectorRule(
			`${ UI_ROOT } .button[role=switch]::after`
		);
		expect( knob?.declarations ).toMatchObject( {
			content: '""',
			top: '1px',
			bottom: '1px',
			left: '1px',
			background: 'var(--paper,var(--np-surface))',
			'border-radius': '50%',
		} );

		const checked = exactSelectorRule(
			`${ UI_ROOT } .button[role=switch][aria-checked=true]`
		);
		expect( checked?.declarations ).toMatchObject( {
			background: 'var(--sage,var(--np-success))',
			'border-color': 'var(--sage,var(--np-success))',
		} );
		expect(
			exactSelectorRule(
				`${ UI_ROOT } .button[role=switch][aria-checked=true]::after`
			)?.declarations.right
		).toBe( '1px' );

		expect(
			exactSelectorRule(
				`${ UI_ROOT } .button[role=switch][aria-checked=true]:hover:not(:disabled):not([disabled]):not([aria-disabled=true])`
			)?.declarations.background
		).toBe( 'var(--sage,var(--np-success))' );
	} );

	it( 'uses Cobalt for the ordinary active-button role', () => {
		const active = exactSelectorRule( `${ UI_ROOT } .button.is-active` );
		expect( active?.declarations ).toMatchObject( {
			background: 'var(--cyan,var(--np-primary))',
			'border-color': 'var(--cyan,var(--np-primary))',
		} );
		expect(
			exactSelectorRule(
				`${ UI_ROOT } .button.is-active:hover:not(:disabled):not([disabled]):not([aria-disabled=true])`
			)?.declarations.background
		).toBe( 'var(--cyan-dark,var(--np-primary-hover))' );
	} );

	it( 'defines paused as a non-emitting canonical button role', () => {
		const mixins = [];
		buttonRolesStylesheet.walkAtRules( 'mixin', ( atRule ) => {
			mixins.push( atRule.params.split( /[\s(]/, 1 )[ 0 ] );
		} );
		expect( mixins ).toContain( 'paused' );
		expect(
			buttonRolesStylesheet.nodes.filter(
				( node ) => 'rule' === node.type
			)
		).toEqual( [] );
	} );

	it( 'paints paused buttons with a distinct warning role', () => {
		const paused = exactSelectorRule( `${ UI_ROOT } .button.is-paused` );
		expect( paused?.declarations ).toMatchObject( {
			background: 'var(--brass,var(--np-warning))',
			color: 'var(--on-brass,var(--np-text))',
			'border-color': 'var(--brass,var(--np-warning))',
		} );

		const hover = exactSelectorRule(
			`${ UI_ROOT } .button.is-paused:hover:not(:disabled):not([disabled]):not([aria-disabled=true])`
		);
		expect( hover?.declarations ).toMatchObject( {
			background: 'var(--brass-dark,var(--np-warning))',
			color: 'var(--on-brass-dark,var(--np-text))',
		} );
		expect( paused?.declarations.background ).not.toBe(
			'var(--oxide,var(--np-error))'
		);
	} );

	it( 'preserves canonical toolbar geometry and text wrapping', () => {
		const columnPicker = exactSelectorRule(
			`${ CUSTOM_UI_ROOT } .newspack-nodes-column-picker`
		);
		expect( columnPicker?.declarations.padding ).toBe( '8px 12px' );
		expect( columnPicker?.declarations[ 'margin-bottom' ] ).toBe( '12px' );

		const stats = exactSelectorRule(
			`${ CUSTOM_UI_ROOT } .newspack-nodes-toolbar-stats`
		);
		expect( stats?.declarations[ 'white-space' ] ).toBe( 'nowrap' );
		expect( stats?.declarations[ 'flex-wrap' ] ).toBeUndefined();
	} );

	it( 'authors the full canonical column-picker frame and label contract', () => {
		const frame = parsedRule(
			toolbarStylesheet,
			( selector ) => '.newspack-nodes-column-picker' === selector
		);
		const label = parsedRule(
			toolbarStylesheet,
			( selector ) => 'label' === selector
		);
		const hover = parsedRule(
			toolbarStylesheet,
			( selector ) => '&:hover' === selector
		);
		expect( label?.ancestors.slice( 0, 2 ) ).toEqual( [
			'.newspack-nodes-column-picker',
			CUSTOM_UI_ROOT,
		] );
		expect( hover?.ancestors.slice( 0, 3 ) ).toEqual( [
			'label',
			'.newspack-nodes-column-picker',
			CUSTOM_UI_ROOT,
		] );

		expect( columnPickerContract( frame, label, hover ) ).toEqual( {
			frame: {
				display: 'flex',
				flexWrap: 'wrap',
				gap: '$space-sm',
				padding: '$space-sm $space-md',
				marginBottom: '$space-md',
				background: 'var(--paper-2,var(--np-surface-subtle))',
				border: '1px solid var(--paper-shadow,var(--np-border-strong))',
				borderRadius: 'var(--button-radius,var(--np-radius-md))',
				fontSize: '12px',
				color: 'var(--ink,var(--np-text))',
			},
			label: {
				display: 'flex',
				alignItems: 'center',
				gap: '$space-xs',
				color: 'var(--ink-3,var(--np-text-secondary))',
				cursor: 'pointer',
			},
			hover: {
				color: 'var(--ink,var(--np-text))',
			},
		} );
	} );

	it( 'compiles the full canonical column-picker frame and label contract', () => {
		const frame = exactSelectorRule(
			`${ CUSTOM_UI_ROOT } .newspack-nodes-column-picker`
		);
		const label = exactSelectorRule(
			`${ CUSTOM_UI_ROOT } .newspack-nodes-column-picker label`
		);
		const hover = exactSelectorRule(
			`${ CUSTOM_UI_ROOT } .newspack-nodes-column-picker label:hover`
		);

		expect( columnPickerContract( frame, label, hover ) ).toEqual( {
			frame: {
				display: 'flex',
				flexWrap: 'wrap',
				gap: '8px',
				padding: '8px 12px',
				marginBottom: '12px',
				background: 'var(--paper-2,var(--np-surface-subtle))',
				border: '1px solid var(--paper-shadow,var(--np-border-strong))',
				borderRadius: 'var(--button-radius,var(--np-radius-md))',
				fontSize: '12px',
				color: 'var(--ink,var(--np-text))',
			},
			label: {
				display: 'flex',
				alignItems: 'center',
				gap: '4px',
				color: 'var(--ink-3,var(--np-text-secondary))',
				cursor: 'pointer',
			},
			hover: {
				color: 'var(--ink,var(--np-text))',
			},
		} );
	} );

	it( 'preserves canonical toolbar count and rate appearance', () => {
		const expectedBase = {
			'font-family': 'var(--np-font-mono)',
			'font-size': '12px',
		};
		const count = exactSelectorRule(
			`${ CUSTOM_UI_ROOT } .newspack-nodes-toolbar-stats__count`
		);
		expect( count?.declarations ).toMatchObject( {
			...expectedBase,
			color: 'var(--ink-3,var(--np-text-secondary))',
		} );

		const rps = exactSelectorRule(
			`${ CUSTOM_UI_ROOT } .newspack-nodes-toolbar-stats__rps`
		);
		expect( rps?.declarations ).toMatchObject( {
			...expectedBase,
			color: 'var(--sage-text,var(--np-text))',
			'font-weight': '700',
		} );
	} );

	it( 'keeps card geometry independent from button geometry', () => {
		for ( const cardSelector of [
			`${ CUSTOM_UI_ROOT } .newspack-nodes-card`,
			`${ CUSTOM_UI_ROOT }.newspack-nodes-card`,
		] ) {
			const card = exactSelectorRule( cardSelector );
			expect( card?.declarations.border ).toBe( '0' );
			expect( card?.declarations[ 'box-shadow' ] ).toBe(
				'inset 0 0 0 1px var(--paper-shadow,var(--np-border-strong))'
			);
			expect( card?.declarations[ 'border-radius' ] ).toBe(
				'var(--np-radius-md)'
			);
		}

		for ( const selector of [
			`${ STOCK_UI_ROOT } .components-card`,
			`${ STOCK_UI_ROOT } .components-surface`,
		] ) {
			const stock = exactSelectorRule( selector );
			expect( stock?.declarations[ 'border-color' ] ).toBe(
				'var(--paper-shadow,var(--np-border-strong))'
			);
			expect( stock?.declarations.border ).toBeUndefined();
			expect( stock?.declarations[ 'border-radius' ] ).toBeUndefined();
		}
	} );

	it( 'gives elevated cards the forward paper rung and subtle outer shadow', () => {
		for ( const elevatedSelector of [
			`${ CUSTOM_UI_ROOT } .newspack-nodes-card--elevated`,
			`${ CUSTOM_UI_ROOT }.newspack-nodes-card--elevated`,
		] ) {
			const elevated = exactSelectorRule( elevatedSelector );
			expect( elevated?.declarations.background ).toBe(
				'var(--paper,var(--np-surface))'
			);
			expect( elevated?.declarations[ 'box-shadow' ] ).toBe(
				'inset 0 0 0 1px var(--paper-shadow,var(--np-border-strong)),0 1px 3px rgba(0,0,0,0.06)'
			);
		}
	} );

	it( 'owns the inherited skin-root type, ink, and tab foreground without layout', () => {
		const expected = {
			'font-family': 'var(--font-mono,var(--np-font-mono))',
			'font-size': '13px',
			'line-height': '1.45',
			color: 'var(--ink,var(--np-text))',
			'--nodes-devtools-fg': 'var(--ink,var(--np-text))',
		};
		const roots = [
			`${ CUSTOM_UI_ROOT }.topology-app`,
			`${ CUSTOM_UI_ROOT }.newspack-nodes-skin-root`,
		];
		const layoutProperties = new Set( [
			'display',
			'grid-template-areas',
			'grid-template-columns',
			'grid-template-rows',
			'height',
			'position',
			'width',
		] );

		for ( const root of roots ) {
			const rule = exactSelectorRule( root );
			expect( rule?.declarations ).toEqual(
				expect.objectContaining( expected )
			);
			expect(
				Object.keys( rule?.declarations ?? {} ).filter( ( property ) =>
					layoutProperties.has( property )
				)
			).toEqual( [] );
			for ( const heading of [ 'h1', 'h2', 'h3', 'h4', 'h5', 'h6' ] ) {
				expect(
					exactSelectorRule( `${ root } ${ heading }` )?.declarations
						.color
				).toBe( 'var(--ink,var(--np-text))' );
			}
		}
	} );

	it( 'gives standalone product roots base type and ink before skin overrides', () => {
		const standaloneSelector = `${ CUSTOM_UI_ROOT }.newspack-nodes-theme`;
		const standalone = exactSelectorRule( standaloneSelector );
		const heading = exactSelectorRule( `${ standaloneSelector } h1` );
		const skinnedSelector = `${ CUSTOM_UI_ROOT }.newspack-nodes-skin-root`;

		expect( standalone?.declarations ).toMatchObject( {
			'font-family': 'var(--np-font)',
			color: 'var(--np-text)',
		} );
		expect( heading?.declarations.color ).toBe( 'var(--np-text)' );
		for ( const property of [
			'display',
			'margin',
			'padding',
			'font-size',
			'line-height',
		] ) {
			expect( standalone?.declarations[ property ] ).toBeUndefined();
		}
		expect(
			rules.findIndex( ( rule ) =>
				rule.selector.split( ',' ).includes( standaloneSelector )
			)
		).toBeLessThan(
			rules.findIndex( ( rule ) =>
				rule.selector.split( ',' ).includes( skinnedSelector )
			)
		);
		expect( customRoleSpecificity( standaloneSelector ) ).toEqual( [
			0, 1, 0,
		] );
	} );

	it( 'owns status-pill typography and compact variants without neutral surface paint', () => {
		const badge = exactSelectorRule(
			`${ CUSTOM_UI_ROOT } .newspack-nodes-status-badge`
		);
		const small = exactSelectorRule(
			`${ CUSTOM_UI_ROOT } .newspack-nodes-status-badge.small`
		);
		const compact = exactSelectorRule(
			`${ CUSTOM_UI_ROOT } .newspack-nodes-status-badge.compact`
		);
		const pill = exactSelectorRule(
			`${ CUSTOM_UI_ROOT } .newspack-nodes-status-badge.is-pill`
		);

		expect( badge?.declarations ).toEqual( {
			display: 'inline-block',
			padding: '2px 8px',
			'border-radius': 'var(--np-radius-sm)',
			'font-size': '10px',
			'font-weight': '600',
			'text-transform': 'uppercase',
			'letter-spacing': '0.3px',
		} );
		expect( small?.declarations ).toEqual( {
			padding: '2px 6px',
			'font-size': '9px',
		} );
		expect( compact?.declarations ).toEqual( {
			padding: '1px 6px',
			'font-size': '9px',
		} );
		expect( pill?.declarations ).toEqual( {
			'border-radius': 'var(--np-radius-full)',
		} );
		for ( const property of [
			'background',
			'border',
			'box-shadow',
			'color',
		] ) {
			expect( badge?.declarations[ property ] ).toBeUndefined();
		}
	} );

	it( 'uses contrast-safe semantic text while status-indicator dots keep raw accents', () => {
		const statusBadge = ( state ) =>
			exactSelectorRule(
				`${ CUSTOM_UI_ROOT } .newspack-nodes-status-badge.${ state }`
			);
		const statusIndicator = ( state ) =>
			exactSelectorRule(
				`${ CUSTOM_UI_ROOT } .newspack-nodes-status-indicator.${ state }`
			);
		const statusDot = ( state ) =>
			exactSelectorRule(
				`${ CUSTOM_UI_ROOT } .newspack-nodes-status-indicator.${ state }::before`
			);

		expect( statusBadge( 'is-info' )?.declarations.color ).toBe(
			'var(--cyan-text,var(--np-text))'
		);
		expect( statusBadge( 'running' )?.declarations.color ).toBe(
			'var(--sage-text,var(--np-text))'
		);
		expect( statusBadge( 'is-warning' )?.declarations.color ).toBe(
			'var(--brass-text,var(--np-text))'
		);
		expect( statusBadge( 'dead' )?.declarations.color ).toBe(
			'var(--oxide-text,var(--np-text))'
		);
		expect( statusIndicator( 'is-success' )?.declarations.color ).toBe(
			'var(--sage-text,var(--np-text))'
		);
		expect( statusIndicator( 'is-warning' )?.declarations.color ).toBe(
			'var(--brass-text,var(--np-text))'
		);
		expect( statusIndicator( 'is-error' )?.declarations.color ).toBe(
			'var(--oxide-text,var(--np-text))'
		);
		expect( statusDot( 'is-success' )?.declarations.background ).toBe(
			'var(--sage,var(--np-success))'
		);
		expect( statusDot( 'is-warning' )?.declarations.background ).toBe(
			'var(--brass,var(--np-warning))'
		);
		expect( statusDot( 'is-error' )?.declarations.background ).toBe(
			'var(--oxide,var(--np-error))'
		);
	} );

	it( 'keeps generic badges on the framed neutral surface', () => {
		const badge = exactSelectorRule(
			`${ CUSTOM_UI_ROOT } .newspack-nodes-badge`
		);

		expect( badge?.declarations ).toEqual( {
			background: 'var(--paper,var(--np-surface))',
			color: 'var(--ink,var(--np-text))',
			border: '0',
			'border-radius': 'var(--np-radius-sm)',
			'box-shadow':
				'inset 0 0 0 1px var(--paper-shadow,var(--np-border-strong))',
		} );
	} );

	it( 'keeps the hoverable card modifier paint-neutral until hover feedback', () => {
		const hoverable = exactSelectorRule(
			`${ CUSTOM_UI_ROOT } .newspack-nodes-card--hoverable`
		);
		const hover = exactSelectorRule(
			`${ CUSTOM_UI_ROOT } .newspack-nodes-card--hoverable:hover`
		);

		expect( hoverable?.declarations ).toEqual( {
			transition: 'box-shadow 0.15s ease',
		} );
		expect( hover?.declarations[ 'box-shadow' ] ).toBe(
			'inset 0 0 0 1px var(--ink-3,var(--np-text-secondary)),0 2px 8px rgba(0,0,0,0.08)'
		);
		expect(
			exactSelectorRule(
				`${ CUSTOM_UI_ROOT } .newspack-nodes-card:hover`
			)
		).toBeUndefined();
	} );

	it( 'owns virtual-table paint through geometry-neutral canonical roles', () => {
		const header = exactSelectorRule(
			`${ CUSTOM_UI_ROOT } .newspack-nodes-table__header`
		);
		const row = exactSelectorRule(
			`${ CUSTOM_UI_ROOT } .newspack-nodes-table__row`
		);
		const cell = exactSelectorRule(
			`${ CUSTOM_UI_ROOT } .newspack-nodes-table__cell`
		);
		const odd = exactSelectorRule(
			`${ CUSTOM_UI_ROOT } .newspack-nodes-table__row.row-odd`
		);
		const even = exactSelectorRule(
			`${ CUSTOM_UI_ROOT } .newspack-nodes-table__row.row-even`
		);
		const hover = exactSelectorRule(
			`${ CUSTOM_UI_ROOT } .newspack-nodes-table__row:hover`
		);
		const selected = exactSelectorRule(
			`${ CUSTOM_UI_ROOT } .newspack-nodes-table__row.is-selected`
		);

		expect( header?.declarations ).toMatchObject( {
			background: 'var(--paper-2,var(--np-surface-subtle))',
			color: 'var(--ink,var(--np-text))',
			'box-shadow':
				'inset 1px 0 var(--paper-shadow,var(--np-border-strong)),inset -1px 0 var(--paper-shadow,var(--np-border-strong)),inset 0 1px var(--paper-shadow,var(--np-border-strong))',
		} );
		expect( header?.declarations.border ).toBeUndefined();
		expect( row?.declarations.color ).toBe( 'var(--ink,var(--np-text))' );
		expect( row?.declarations[ 'border-bottom' ] ).toBe(
			'1px solid var(--paper-shadow,var(--np-border-strong))'
		);
		expect( cell?.declarations.color ).toBe( 'inherit' );
		expect( odd?.declarations.background ).toBe(
			'var(--paper-2,var(--np-surface-subtle))'
		);
		expect( even?.declarations.background ).toContain( 'color-mix(' );
		expect( hover?.declarations.background ).toContain( 'color-mix(' );
		expect( selected?.declarations.background ).toBe(
			'var(--cyan-subtle,var(--np-primary-subtle))'
		);
		expect(
			exactSelectorRule(
				`${ CUSTOM_UI_ROOT } .newspack-nodes-table__header + .newspack-nodes-table[role=rowgroup]`
			)?.declarations[ 'border-top-color' ]
		).toBe( 'var(--paper-shadow,var(--np-border-strong))' );

		const geometryProperties = new Set( [
			'align-items',
			'display',
			'font-size',
			'gap',
			'height',
			'line-height',
			'margin',
			'min-height',
			'padding',
			'position',
			'width',
		] );
		expect(
			[ header, row, cell, odd, even, hover, selected ].flatMap(
				( rule ) =>
					Object.keys( rule?.declarations ?? {} ).filter(
						( property ) => geometryProperties.has( property )
					)
			)
		).toEqual( [] );
	} );

	it( 'owns sortable-header interaction after the non-interactive cell role', () => {
		const headerCellSelector = `${ CUSTOM_UI_ROOT } .newspack-nodes-table__header .newspack-nodes-table__cell`;
		const sortableSelector = `${ CUSTOM_UI_ROOT } .newspack-nodes-table__header .newspack-nodes-sortable-header-button`;
		const hoverSelector = `${ sortableSelector }:hover`;
		const sortable = exactSelectorRule( sortableSelector );
		const hover = exactSelectorRule( hoverSelector );

		expect( sortable?.declarations ).toMatchObject( {
			background: 'transparent',
			border: '0',
			padding: '0',
			font: 'inherit',
			'font-weight': '600',
			cursor: 'pointer',
			'user-select': 'none',
			'letter-spacing': 'normal',
			'text-transform': 'none',
			color: 'var(--ink,var(--np-text))',
		} );
		expect( sortable?.declarations[ 'text-align' ] ).toBeUndefined();
		expect( hover?.declarations.color ).toBe(
			'var(--cyan-text,var(--np-text))'
		);
		expect( sortable?.importantProperties ).toEqual( [] );
		expect( hover?.importantProperties ).toEqual( [] );
		expect( customRoleSpecificity( sortableSelector ) ).toEqual(
			customRoleSpecificity( headerCellSelector )
		);
		expect(
			rules.findIndex( ( rule ) =>
				rule.selector.split( ',' ).includes( headerCellSelector )
			)
		).toBeLessThan(
			rules.findIndex( ( rule ) =>
				rule.selector.split( ',' ).includes( sortableSelector )
			)
		);
		expect(
			JSON.stringify( {
				base: sortable?.declarations,
				hover: hover?.declarations,
			} )
		).not.toMatch( /--button-secondary/ );
	} );

	it( 'owns compact standalone stat labels without changing large-stat casing', () => {
		const standalone = exactSelectorRule(
			`${ CUSTOM_UI_ROOT } .newspack-nodes-stat-label`
		);
		const large = exactSelectorRule(
			`${ CUSTOM_UI_ROOT } .newspack-nodes-stat .newspack-nodes-stat-label`
		);

		expect( standalone?.declarations ).toEqual( {
			color: 'var(--ink-3,var(--np-text-secondary))',
			'font-size': '9px',
			'text-transform': 'uppercase',
			'letter-spacing': '0.3px',
		} );
		expect( large?.declarations ).toEqual( {
			'font-size': '14px',
			'text-transform': 'none',
			'letter-spacing': 'normal',
		} );
	} );

	it( 'owns semantic status text colors in the canonical status role', () => {
		expect(
			exactSelectorRule(
				`${ CUSTOM_UI_ROOT } .newspack-nodes-status.is-success`
			)?.declarations.color
		).toBe( 'var(--sage-text,var(--np-text))' );
		expect(
			exactSelectorRule(
				`${ CUSTOM_UI_ROOT } .newspack-nodes-status.is-error`
			)?.declarations.color
		).toBe( 'var(--oxide-text,var(--np-text))' );
		expect(
			exactSelectorRule(
				`${ CUSTOM_UI_ROOT } .newspack-nodes-status.is-accent`
			)?.declarations.color
		).toBe( 'var(--oxide-text,var(--np-text))' );
		expect(
			exactSelectorRule(
				`${ CUSTOM_UI_ROOT } .newspack-nodes-stat-value`
			)?.declarations.color
		).toBe( 'var(--ink,var(--np-text))' );
		expect(
			exactSelectorRule(
				`${ CUSTOM_UI_ROOT } .newspack-nodes-stat-value.is-accent`
			)?.declarations.color
		).toBe( 'var(--oxide-text,var(--np-text))' );
	} );

	it( 'owns compact command-label typography in the shared button role', () => {
		const compact = exactSelectorRule( `${ UI_ROOT } .button.is-compact` );

		expect( compact?.declarations ).toMatchObject( {
			'font-family': 'var(--font-mono,var(--np-font-mono))',
			'font-weight': '700',
			'letter-spacing': '0.14em',
			'text-transform': 'uppercase',
		} );
	} );

	it( 'gives every component source alias an explicit product-token fallback', () => {
		expect( fallbackOffenders( componentsStylesheet, () => true ) ).toEqual(
			[]
		);
	} );

	it( 'keeps compiled component aliases resolved after Sass expansion', () => {
		expect(
			fallbackOffenders( stylesheet, ( selector ) =>
				COMPONENT_SELECTOR_MARKERS.some( ( marker ) =>
					selector.includes( marker )
				)
			)
		).toEqual( [] );
	} );
} );
