import fs from 'fs';
import path from 'path';
import * as sass from 'sass';
// postcss-scss declares PostCSS as a required peer; this test matches freshly
// compiled canonical CSS against the real component DOM.
// eslint-disable-next-line import/no-extraneous-dependencies
import postcss from 'postcss';
import { fireEvent, render } from '@testing-library/react';
import DevtoolsTabHost from '../../shared/devtools/DevtoolsTabHost';
import {
	registerDevtoolsTab,
	resetDevtoolsTabs,
} from '../../shared/devtools/tabRegistry';
import LogBrowser from '../../shared/components/LogBrowser';
import LogStreamViewer from '../../shared/components/LogStreamViewer';
import DebugOverlay from '../../debug-overlay/DebugOverlay';
import { TopologyRow } from '../../event-dashboards/TopologyRow';
import Header from '../../topology-console/components/Header';
import ReplFooter from '../../topology-console/components/ReplFooter';
import { ModalShell } from '../../topology-console/components/Modal';

const ROOT = path.resolve( __dirname, '../../..' );
const UI_SCSS = path.join( ROOT, 'src/ui/newspack-nodes-ui.scss' );
const THEME_SCSS = path.join( ROOT, 'src/theme/newspack-theme.scss' );
const LOG_VIEWER = path.join( ROOT, 'src/event-dashboards/LogViewer.js' );
const uiStylesheet = postcss.parse( sass.compile( UI_SCSS ).css, {
	from: UI_SCSS,
} );
const themeStylesheet = postcss.parse( sass.compile( THEME_SCSS ).css, {
	from: THEME_SCSS,
} );

// Deliberately unlike every product/skin default and fallback: if a canonical
// rule stops consuming the skin contract, these probes cannot pass by accident.
const SENTINELS = {
	paper: '#fef102',
	paper2: '#e5c20b',
	paper3: '#c9a517',
	shadow: '#7b4a91',
	ink: '#152947',
	ink2: '#284b73',
	ink3: '#3d638d',
	ink4: '#527aa7',
	statusText: '#283f68',
	mutedText: '#496889',
	fontUi: '"Request UI Sentinel 641", sans-serif',
	fontMono: '"Panel Sentinel 947", monospace',
	fontTerminal: '"Request Data Sentinel 283", monospace',
	cyan: '#1267d3',
	cyanText: '#204f9f',
	cyanSubtle: '#b7d92e',
	brass: '#a64f17',
	brassText: '#71420d',
	brassSubtle: '#f2c866',
	oxide: '#ca315c',
	oxideText: '#9c1d42',
	oxideSubtle: '#fac4cf',
	sage: '#269e61',
	sageText: '#17613d',
	sageSubtle: '#a7e1bd',
	replBackground: '#071421',
	replForeground: '#d6f3ff',
	onCyan: '#fff7cc',
	onOxide: '#fff1c7',
	radiusSmall: '13px',
	radiusMedium: '29px',
	radiusFull: '71px',
	buttonRadius: '47px',
	secondaryBackground: '#e86f13',
	secondaryBorder: '#8842ce',
	secondaryColor: '#397a2c',
};
const sentinelStyle = {
	'--paper': SENTINELS.paper,
	'--paper-2': SENTINELS.paper2,
	'--paper-3': SENTINELS.paper3,
	'--paper-shadow': SENTINELS.shadow,
	'--ink': SENTINELS.ink,
	'--ink-2': SENTINELS.ink2,
	'--ink-3': SENTINELS.ink3,
	'--ink-4': SENTINELS.ink4,
	'--status-text': SENTINELS.statusText,
	'--muted-text': SENTINELS.mutedText,
	'--np-font': SENTINELS.fontUi,
	'--font-mono': SENTINELS.fontMono,
	'--font-terminal': SENTINELS.fontTerminal,
	'--cyan': SENTINELS.cyan,
	'--cyan-text': SENTINELS.cyanText,
	'--cyan-subtle': SENTINELS.cyanSubtle,
	'--brass': SENTINELS.brass,
	'--brass-text': SENTINELS.brassText,
	'--brass-subtle': SENTINELS.brassSubtle,
	'--oxide': SENTINELS.oxide,
	'--oxide-text': SENTINELS.oxideText,
	'--oxide-subtle': SENTINELS.oxideSubtle,
	'--sage-text': SENTINELS.sageText,
	'--sage': SENTINELS.sage,
	'--sage-subtle': SENTINELS.sageSubtle,
	'--repl-bg': SENTINELS.replBackground,
	'--repl-fg': SENTINELS.replForeground,
	'--on-cyan': SENTINELS.onCyan,
	'--on-oxide': SENTINELS.onOxide,
	'--np-radius-sm': SENTINELS.radiusSmall,
	'--np-radius-md': SENTINELS.radiusMedium,
	'--np-radius-full': SENTINELS.radiusFull,
	'--button-radius': SENTINELS.buttonRadius,
	'--button-secondary-background': SENTINELS.secondaryBackground,
	'--button-secondary-border': SENTINELS.secondaryBorder,
	'--button-secondary-color': SENTINELS.secondaryColor,
};

const normalize = ( value ) =>
	value
		.replace( /\s+/g, ' ' )
		.replace( /\s*,\s*/g, ',' )
		.trim();

const matchingDeclarationsFrom = ( stylesheet, element ) => {
	const matches = new Map();
	stylesheet.walkRules( ( rule ) => {
		for ( const selector of rule.selectors ) {
			try {
				if ( element.matches( selector ) ) {
					rule.walkDecls( ( declaration ) => {
						matches.set(
							declaration.prop,
							normalize( declaration.value )
						);
					} );
					break;
				}
			} catch ( _error ) {
				// Pseudo-elements and inactive state pseudos cannot match a node.
			}
		}
	} );
	return Object.fromEntries( matches );
};
const matchingDeclarations = ( element ) =>
	matchingDeclarationsFrom( uiStylesheet, element );

const pseudoRuleReaches = ( element, pseudo, declarations ) => {
	let matched = false;
	uiStylesheet.walkRules( ( rule ) => {
		for ( const selector of rule.selectors ) {
			if ( ! selector.endsWith( pseudo ) ) {
				continue;
			}
			const hostSelector = selector.slice( 0, -pseudo.length );
			if ( ! element.matches( hostSelector ) ) {
				continue;
			}
			const actual = Object.fromEntries(
				( rule.nodes || [] )
					.filter( ( node ) => 'decl' === node.type )
					.map( ( declaration ) => [
						declaration.prop,
						normalize( declaration.value ),
					] )
			);
			if (
				Object.entries( declarations ).every(
					( [ property, value ] ) => actual[ property ] === value
				)
			) {
				matched = true;
			}
		}
	} );
	return matched;
};

const tokenValue = ( element, token ) => {
	let current = element;
	while ( current ) {
		const value = current.style?.getPropertyValue( token );
		if ( value ) {
			return value;
		}
		current = current.parentElement;
	}
	return '';
};

const expectUsesSentinel = ( element, property, token, sentinel ) => {
	expect( matchingDeclarations( element )[ property ] ).toContain(
		`var(${ token }`
	);
	expect( tokenValue( element, token ) ).toBe( sentinel );
};

const skinDeclarations = ( skinRoot, skin ) => {
	const declarations = {};
	const ancestorSelector = `.theme-${ skin }`;
	themeStylesheet.walkRules( ( rule ) => {
		for ( const selector of rule.selectors ) {
			if ( ! selector.startsWith( `${ ancestorSelector } ` ) ) {
				continue;
			}
			const rootSelector = selector.slice( ancestorSelector.length + 1 );
			if (
				! skinRoot.parentElement?.matches( ancestorSelector ) ||
				! skinRoot.matches( rootSelector )
			) {
				continue;
			}
			rule.walkDecls( ( declaration ) => {
				declarations[ declaration.prop ] = normalize(
					declaration.value
				);
			} );
		}
	} );
	return declarations;
};

const declarationsForSelector = ( selectorFragment ) => {
	const declarations = {};
	uiStylesheet.walkRules( ( rule ) => {
		if (
			rule.selectors.some( ( selector ) =>
				selector.includes( selectorFragment )
			)
		) {
			rule.walkDecls( ( declaration ) => {
				declarations[ declaration.prop ] = normalize(
					declaration.value
				);
			} );
		}
	} );
	return declarations;
};

const provider = ( child, skin = 'newspack' ) => (
	<div className={ `theme-${ skin }` }>
		<div
			className="newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui"
			style={ sentinelStyle }
		>
			{ child }
		</div>
	</div>
);

const topologyRow = ( source = 'stock', health = 'ok' ) => (
	<TopologyRow
		topology={ {
			name: `semantic-${ source }`,
			source,
			active: true,
			health,
			status: {
				workers: [
					{
						partition: 0,
						status: 'running',
						started_at: 947,
					},
				],
				currentTime: 1947,
			},
		} }
		folded
		onActivate={ () => {} }
		onDeactivate={ () => {} }
		onRestart={ () => {} }
		onError={ () => {} }
		onExpand={ () => {} }
	/>
);

describe( 'distinctive canonical roles', () => {
	beforeEach( () => {
		resetDevtoolsTabs();
		window.localStorage.clear();
	} );

	it( 'keeps card and badge radii independent from the button-radius decoy', () => {
		const { container } = render(
			provider(
				<div className="newspack-nodes-card">
					<span className="newspack-nodes-badge">Badge probe</span>
				</div>
			)
		);
		const card = container.querySelector( '.newspack-nodes-card' );
		const badge = container.querySelector( '.newspack-nodes-badge' );

		expectUsesSentinel(
			card,
			'border-radius',
			'--np-radius-md',
			SENTINELS.radiusMedium
		);
		expectUsesSentinel(
			badge,
			'border-radius',
			'--np-radius-sm',
			SENTINELS.radiusSmall
		);
		expect( tokenValue( card, '--button-radius' ) ).toBe(
			SENTINELS.buttonRadius
		);
		expect( matchingDeclarations( card )[ 'border-radius' ] ).not.toContain(
			'--button-radius'
		);
		expect(
			matchingDeclarations( badge )[ 'border-radius' ]
		).not.toContain( '--button-radius' );
	} );

	it( 'reaches a body-portaled card whose provider classes share its element', () => {
		const { getByTestId } = render(
			<div className="theme-newspack">
				<div
					data-testid="portaled-card-probe"
					className="newspack-nodes-card newspack-nodes-card--elevated newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui"
					style={ sentinelStyle }
				/>
			</div>
		);
		const card = getByTestId( 'portaled-card-probe' );
		const cardDeclarations = matchingDeclarations( card );

		expectUsesSentinel( card, 'background', '--paper', SENTINELS.paper );
		expectUsesSentinel(
			card,
			'border-radius',
			'--np-radius-md',
			SENTINELS.radiusMedium
		);
		expect( cardDeclarations[ 'box-shadow' ] ).toContain(
			'var(--paper-shadow'
		);
		expect( tokenValue( card, '--paper-shadow' ) ).toBe( SENTINELS.shadow );
	} );

	it( 'keeps sortable headers on semantic ink instead of secondary-button paint', () => {
		const { getByRole } = render(
			provider(
				<div className="newspack-nodes-table__header">
					<button
						type="button"
						className="newspack-nodes-sortable-header-button newspack-nodes-table__cell"
					>
						Sortable probe
					</button>
				</div>
			)
		);
		const sortable = getByRole( 'button', { name: 'Sortable probe' } );
		const declarations = matchingDeclarations( sortable );

		expect( sortable.classList.contains( 'button' ) ).toBe( false );
		expect( sortable.classList.contains( 'button-small' ) ).toBe( false );
		expect( declarations ).toMatchObject( {
			background: 'transparent',
			border: '0',
			padding: '0',
			font: 'inherit',
			cursor: 'pointer',
			'letter-spacing': 'normal',
			'text-transform': 'none',
			color: 'var(--ink,var(--np-text))',
		} );
		expect( declarations[ 'text-align' ] ).toBeUndefined();
		expectUsesSentinel( sortable, 'color', '--ink', SENTINELS.ink );
		expect(
			pseudoRuleReaches( sortable, ':hover', {
				color: 'var(--cyan-text,var(--np-text))',
			} )
		).toBe( true );
		for ( const [ token, sentinel ] of [
			[ '--button-secondary-background', SENTINELS.secondaryBackground ],
			[ '--button-secondary-border', SENTINELS.secondaryBorder ],
			[ '--button-secondary-color', SENTINELS.secondaryColor ],
		] ) {
			expect( tokenValue( sortable, token ) ).toBe( sentinel );
			expect( JSON.stringify( declarations ) ).not.toContain( token );
		}
	} );

	it( 'restores quiet request actions and native request-table semantics', () => {
		const { container, getByRole } = render(
			provider(
				<>
					<button type="button" className="button-link">
						Show 13 more categories
					</button>
					<span className="newspack-nodes-status is-info">
						&#9654;
					</span>
					<table
						aria-label="Request diagnostics"
						className="newspack-nodes-table newspack-nodes-table--undivided"
					>
						<thead>
							<tr>
								<th>Category</th>
								<th>Time</th>
							</tr>
						</thead>
						<tbody>
							<tr>
								<td>hooks</td>
								<td className="newspack-nodes-table__terminal-data">
									19.47ms
								</td>
							</tr>
							<tr className="newspack-nodes-table__details">
								<td colSpan="2">
									<table className="newspack-nodes-table newspack-nodes-table--undivided">
										<tbody>
											<tr>
												<td>callback_probe</td>
												<td className="newspack-nodes-table__terminal-data">
													7.31ms
												</td>
											</tr>
										</tbody>
									</table>
								</td>
							</tr>
						</tbody>
						<tfoot>
							<tr className="newspack-nodes-table__summary">
								<td>Total Profiled</td>
								<td className="newspack-nodes-table__terminal-data">
									26.78ms
								</td>
							</tr>
						</tfoot>
					</table>
					<table
						aria-label="Logging rules"
						className="newspack-nodes-table newspack-nodes-table--undivided"
					>
						<thead>
							<tr>
								<th>Pattern</th>
								<th>Action</th>
							</tr>
						</thead>
						<tbody>
							<tr>
								<td>/sentinel-641</td>
								<td>Log</td>
							</tr>
						</tbody>
					</table>
				</>
			)
		);
		const quietLink = getByRole( 'button', {
			name: 'Show 13 more categories',
		} );
		const disclosure = container.querySelector(
			'.newspack-nodes-status.is-info'
		);
		const table = container.querySelector(
			'[aria-label="Request diagnostics"]'
		);
		const rulesTable = container.querySelector(
			'[aria-label="Logging rules"]'
		);
		const header = table.querySelector( 'thead th:nth-child(2)' );
		const label = table.querySelector( 'tbody > tr > td:first-child' );
		const value = table.querySelector( 'tbody > tr > td:nth-child(2)' );
		const nested = table.querySelector(
			'tbody .newspack-nodes-table--undivided'
		);
		const details = table.querySelector( '.newspack-nodes-table__details' );
		const nestedRow = nested.querySelector( 'tbody tr' );
		const nestedValue = nested.querySelector( 'td:nth-child(2)' );
		const summary = table.querySelector(
			'tfoot .newspack-nodes-table__summary'
		);
		const summaryValue = summary.querySelector( 'td:nth-child(2)' );
		const rulesHeader = rulesTable.querySelector( 'thead th:nth-child(2)' );
		const rulesValue = rulesTable.querySelector( 'tbody td:nth-child(2)' );

		expect( matchingDeclarations( quietLink ) ).toMatchObject( {
			appearance: 'none',
			background: 'transparent',
			border: '0',
			'box-shadow': 'none',
			color: 'var(--cyan-text,var(--np-text))',
			cursor: 'pointer',
			font: 'inherit',
			'text-decoration': 'none',
		} );
		expectUsesSentinel(
			quietLink,
			'color',
			'--cyan-text',
			SENTINELS.cyanText
		);
		expect(
			pseudoRuleReaches( quietLink, ':hover', {
				'text-decoration': 'underline',
			} )
		).toBe( true );
		expect( matchingDeclarations( disclosure ).color ).toBe(
			'var(--cyan-text,var(--np-text))'
		);
		expectUsesSentinel(
			disclosure,
			'color',
			'--cyan-text',
			SENTINELS.cyanText
		);
		expect( matchingDeclarations( header )[ 'font-weight' ] ).toBe( '400' );
		expect(
			matchingDeclarations( header )[ 'font-family' ]
		).toBeUndefined();
		expect( tokenValue( header, '--np-font' ) ).toBe( SENTINELS.fontUi );
		expect(
			matchingDeclarations( label )[ 'font-family' ]
		).toBeUndefined();
		for ( const bodyOrFooterCell of [
			label,
			value,
			nestedValue,
			summaryValue,
			rulesValue,
		] ) {
			expect( matchingDeclarations( bodyOrFooterCell ) ).toMatchObject( {
				'font-size': '13px',
				'line-height': '1.5',
			} );
		}
		for ( const dataCell of [ value, nestedValue, summaryValue ] ) {
			expect( matchingDeclarations( dataCell ) ).toMatchObject( {
				'border-bottom': '0',
				'font-family': 'var(--font-terminal,var(--np-font-mono))',
			} );
			expectUsesSentinel(
				dataCell,
				'font-family',
				'--font-terminal',
				SENTINELS.fontTerminal
			);
		}
		expect( matchingDeclarations( nested ) ).toMatchObject( {
			background: 'transparent',
			border: '0',
		} );
		expect( matchingDeclarations( details ).background ).toBe(
			'var(--paper-2,var(--np-surface-subtle))'
		);
		expectUsesSentinel(
			details,
			'background',
			'--paper-2',
			SENTINELS.paper2
		);
		expect( matchingDeclarations( nestedRow ).background ).toBe(
			'transparent'
		);
		expect( matchingDeclarations( rulesHeader )[ 'font-weight' ] ).toBe(
			'400'
		);
		expect(
			matchingDeclarations( rulesHeader )[ 'font-family' ]
		).toBeUndefined();
		expect( matchingDeclarations( rulesValue ) ).toMatchObject( {
			'border-bottom': '0',
		} );
		expect(
			matchingDeclarations( rulesValue )[ 'font-family' ]
		).toBeUndefined();
		expect( tokenValue( rulesValue, '--font-terminal' ) ).toBe(
			SENTINELS.fontTerminal
		);
		expect( matchingDeclarations( summary ) ).toMatchObject( {
			background: 'var(--paper-2,var(--np-surface-subtle))',
			'font-weight': '700',
		} );
		expectUsesSentinel(
			summary,
			'background',
			'--paper-2',
			SENTINELS.paper2
		);
	} );

	it( 'maps neutral, warning, and muted metadata to distinct status inks', () => {
		const { getByTestId } = render(
			provider(
				<>
					<span
						data-testid="neutral-metadata"
						className="newspack-nodes-status"
					>
						(17.615ms)
					</span>
					<span
						data-testid="warning-metadata"
						className="newspack-nodes-status is-warning"
					>
						[641MB]
					</span>
					<span
						data-testid="muted-metadata"
						className="newspack-nodes-status is-muted"
					>
						[283 entries]
					</span>
				</>
			)
		);
		const neutral = getByTestId( 'neutral-metadata' );
		const warning = getByTestId( 'warning-metadata' );
		const muted = getByTestId( 'muted-metadata' );

		expect( [
			matchingDeclarations( neutral ).color,
			matchingDeclarations( warning ).color,
			matchingDeclarations( muted ).color,
		] ).toEqual( [
			'var(--status-text,var(--np-text-secondary))',
			'var(--brass-text,var(--np-text))',
			'var(--muted-text,var(--np-text-secondary))',
		] );
		expect( [
			tokenValue( neutral, '--status-text' ),
			tokenValue( warning, '--brass-text' ),
			tokenValue( muted, '--muted-text' ),
		] ).toEqual( [
			SENTINELS.statusText,
			SENTINELS.brassText,
			SENTINELS.mutedText,
		] );
	} );

	it( 'renders the topology disclosure as a bare canonical control instead of a secondary button', () => {
		const { container } = render( provider( topologyRow() ) );
		const disclosure = container.querySelector( '.nodes-tm__expand' );
		const declarations = matchingDeclarations( disclosure );

		expect(
			disclosure.classList.contains( 'newspack-nodes-disclosure' )
		).toBe( true );
		expect( disclosure.classList.contains( 'button' ) ).toBe( false );
		expect( disclosure.classList.contains( 'button-small' ) ).toBe( false );
		expect( declarations ).toMatchObject( {
			appearance: 'none',
			background: 'transparent',
			border: '0',
			'box-shadow': 'none',
			color: 'var(--ink-3,var(--np-text-secondary))',
			cursor: 'pointer',
		} );
		expectUsesSentinel( disclosure, 'color', '--ink-3', SENTINELS.ink3 );
		expect(
			pseudoRuleReaches( disclosure, ':hover', {
				background: 'var(--hover,var(--np-surface-muted))',
				color: 'var(--ink,var(--np-text))',
			} )
		).toBe( true );
		for ( const token of [
			'--button-secondary-background',
			'--button-secondary-border',
			'--button-secondary-color',
		] ) {
			expect( JSON.stringify( declarations ) ).not.toContain( token );
		}
	} );

	it.each( [
		[
			'stock',
			'is-info',
			'--cyan-subtle',
			SENTINELS.cyanSubtle,
			'--cyan-text',
			SENTINELS.cyanText,
		],
		[
			'user',
			'is-neutral',
			'--paper-3',
			SENTINELS.paper3,
			'--ink-3',
			SENTINELS.ink3,
		],
		[
			'both',
			'is-warning',
			'--brass-subtle',
			SENTINELS.brassSubtle,
			'--brass-text',
			SENTINELS.brassText,
		],
	] )(
		'renders %s provenance through the canonical status pill and semantic tone',
		(
			source,
			tone,
			backgroundToken,
			backgroundSentinel,
			colorToken,
			colorSentinel
		) => {
			const { container } = render( provider( topologyRow( source ) ) );
			const provenance = container.querySelector( '.nodes-tm__badge' );
			const declarations = matchingDeclarations( provenance );

			expect(
				provenance.classList.contains( 'newspack-nodes-status-badge' )
			).toBe( true );
			expect( provenance.classList.contains( 'is-pill' ) ).toBe( true );
			expect( provenance.classList.contains( tone ) ).toBe( true );
			expect(
				provenance.classList.contains( 'newspack-nodes-badge' )
			).toBe( false );
			expect( declarations ).toMatchObject( {
				'border-radius': 'var(--np-radius-full)',
				'font-weight': '600',
				'letter-spacing': '0.3px',
				'text-transform': 'uppercase',
			} );
			expectUsesSentinel(
				provenance,
				'border-radius',
				'--np-radius-full',
				SENTINELS.radiusFull
			);
			expectUsesSentinel(
				provenance,
				'background',
				backgroundToken,
				backgroundSentinel
			);
			expectUsesSentinel(
				provenance,
				'color',
				colorToken,
				colorSentinel
			);
			expect( declarations.border ).toBeUndefined();
			expect( declarations[ 'box-shadow' ] ).toBeUndefined();
		}
	);

	it.each( [
		[
			'ok',
			'is-success',
			'--sage-text',
			SENTINELS.sageText,
			'var(--sage,var(--np-success))',
		],
		[
			'behind',
			'is-warning',
			'--brass-text',
			SENTINELS.brassText,
			'var(--brass,var(--np-warning))',
		],
		[
			'stalled',
			'is-error',
			'--oxide-text',
			SENTINELS.oxideText,
			'var(--oxide,var(--np-error))',
		],
	] )(
		'renders %s health with contrast-safe label text and a raw semantic dot',
		( state, tone, textToken, textSentinel, accentValue ) => {
			const { container } = render(
				provider( topologyRow( 'stock', state ) )
			);
			const health = container.querySelector( '.nodes-tm__health' );
			const declarations = matchingDeclarations( health );

			expect(
				health.classList.contains( 'newspack-nodes-status-indicator' )
			).toBe( true );
			expect( health.classList.contains( tone ) ).toBe( true );
			expect( declarations ).toMatchObject( {
				display: 'inline-flex',
				'align-items': 'center',
				gap: '5px',
				'font-size': '10px',
				'font-weight': '600',
				'letter-spacing': '0.3px',
				'text-transform': 'uppercase',
			} );
			expectUsesSentinel( health, 'color', textToken, textSentinel );
			expect(
				pseudoRuleReaches( health, '::before', {
					content: '""',
					width: '8px',
					height: '8px',
					'border-radius': '50%',
				} )
			).toBe( true );
			expect(
				pseudoRuleReaches( health, '::before', {
					background: accentValue,
				} )
			).toBe( true );
		}
	);

	it( 'keeps P0 and ALL RUN on small-radius badges with independent success-text probes', () => {
		const { container } = render( provider( topologyRow() ) );
		const running = [
			...container.querySelectorAll( '.worker-status-badge.running' ),
		];
		const partition = running.find( ( badge ) =>
			badge.textContent.includes( 'P0' )
		);
		const liveness = running.find( ( badge ) =>
			badge.textContent.includes( 'ALL RUN' )
		);

		expect( partition ).toBeDefined();
		expect( liveness ).toBeDefined();
		for ( const badge of [ partition, liveness ] ) {
			expect( badge.classList.contains( 'is-pill' ) ).toBe( false );
			expectUsesSentinel(
				badge,
				'border-radius',
				'--np-radius-sm',
				SENTINELS.radiusSmall
			);
			expectUsesSentinel(
				badge,
				'background',
				'--sage-subtle',
				SENTINELS.sageSubtle
			);
			expectUsesSentinel(
				badge,
				'color',
				'--sage-text',
				SENTINELS.sageText
			);
		}
	} );

	it( 'paints selected table rows through the canonical state role', () => {
		const { getByText } = render(
			provider(
				<div className="newspack-nodes-table__row is-selected">
					Selected row sentinel
				</div>
			)
		);
		const row = getByText( 'Selected row sentinel' );
		const rowDeclarations = matchingDeclarations( row );

		expectUsesSentinel(
			row,
			'background',
			'--cyan-subtle',
			SENTINELS.cyanSubtle
		);
		expect( rowDeclarations[ 'border-bottom' ] ).toContain(
			'var(--paper-shadow'
		);
		expect( tokenValue( row, '--paper-shadow' ) ).toBe( SENTINELS.shadow );
	} );

	it( 'keeps standalone stat labels compact while large stats restore normal casing', () => {
		const { getByText } = render(
			provider(
				<>
					<span className="newspack-nodes-stat-label">
						Compact stat sentinel
					</span>
					<div className="newspack-nodes-stat">
						<span className="newspack-nodes-stat-label">
							Large stat sentinel
						</span>
					</div>
				</>
			)
		);
		const compact = getByText( 'Compact stat sentinel' );
		const large = getByText( 'Large stat sentinel' );
		const compactDeclarations = matchingDeclarations( compact );
		const largeDeclarations = matchingDeclarations( large );

		expectUsesSentinel( compact, 'color', '--ink-3', SENTINELS.ink3 );
		expect( compactDeclarations ).toMatchObject( {
			'font-size': '9px',
			'text-transform': 'uppercase',
			'letter-spacing': '0.3px',
		} );
		expect( largeDeclarations ).toMatchObject( {
			'font-size': '14px',
			'text-transform': 'none',
			'letter-spacing': 'normal',
		} );
	} );

	it( 'renders DevTools navigation as underline tabs instead of generic buttons', () => {
		registerDevtoolsTab( {
			id: 'first',
			label: 'First',
			host: 'hub',
			order: 0,
			component: () => <div>First panel</div>,
		} );
		registerDevtoolsTab( {
			id: 'second',
			label: 'Second',
			host: 'hub',
			order: 1,
			component: () => <div>Second panel</div>,
		} );
		const { getByRole } = render(
			provider( <DevtoolsTabHost host="hub" /> )
		);
		const activeTab = getByRole( 'tab', { name: 'First' } );

		expect( activeTab.classList.contains( 'nodes-devtools__tab' ) ).toBe(
			true
		);
		expect( activeTab.classList.contains( 'button' ) ).toBe( false );
		expect( matchingDeclarations( activeTab ) ).toMatchObject( {
			background: 'transparent',
			'border-bottom-color': 'var(--cyan,var(--np-primary))',
			'border-bottom-style': 'solid',
			'border-bottom-width': '2px',
		} );
		expectUsesSentinel(
			activeTab,
			'border-bottom-color',
			'--cyan',
			SENTINELS.cyan
		);
	} );

	it.each( [
		[ 'newspack', '--cyan', SENTINELS.cyan ],
		[ 'newspack-brand', '--sage', SENTINELS.sage ],
	] )(
		'emits reachable %s header art from the canonical UI asset',
		( skin, separatorToken, separatorSentinel ) => {
			const { container } = render(
				provider( <Header showControls={ false } />, skin )
			);
			const brand = container.querySelector( '.topology-brand' );
			const separator = container.querySelector(
				'.topology-brand__colon'
			);

			expect(
				pseudoRuleReaches( brand, '::before', {
					content: '""',
					width: '32px',
					height: '32px',
					'flex-shrink': '0',
					'background-size': '32px',
					'background-repeat': 'no-repeat',
				} )
			).toBe( true );
			// Inlined, not a file URL: these styles are bundled into every
			// consumer, where a relative URL resolves against the wrong plugin.
			expect( uiStylesheet.toString() ).toContain(
				'url("data:image/png;base64,'
			);
			expect( matchingDeclarations( separator ).color ).toBe(
				'--cyan' === separatorToken
					? 'var(--cyan,var(--np-primary))'
					: 'var(--sage,var(--np-success))'
			);
			expectUsesSentinel(
				separator,
				'color',
				separatorToken,
				separatorSentinel
			);
		}
	);

	it.each( [ 'newspack', 'newspack-brand' ] )(
		'keeps an ordinary %s secondary action rounded and cyan outlined',
		( skin ) => {
			const { getByRole } = render(
				provider(
					<button type="button" className="button button-secondary">
						Secondary probe
					</button>,
					skin
				)
			);
			const secondary = getByRole( 'button', {
				name: 'Secondary probe',
			} );
			const skinRoot = secondary.closest( '.newspack-nodes-skin-root' );

			expect( matchingDeclarations( secondary ) ).toMatchObject( {
				background:
					'var(--button-secondary-background,var(--paper,var(--np-surface)))',
				'border-color':
					'var(--button-secondary-border,var(--paper-shadow,var(--np-border-strong)))',
				'border-radius': 'var(--button-radius,5px)',
				color: 'var(--button-secondary-color,var(--ink,var(--np-text)))',
			} );
			expect( skinDeclarations( skinRoot, skin ) ).toMatchObject( {
				'--button-radius': '5px',
				'--button-secondary-border': 'var(--cyan)',
				'--button-secondary-color': 'var(--cyan)',
			} );
			expect( tokenValue( secondary, '--cyan' ) ).toBe( SENTINELS.cyan );
		}
	);

	it( 'keeps decorative secondary actions on their neutral skin ramp', () => {
		const { getByRole } = render(
			provider(
				<button type="button" className="button button-secondary">
					Decorative secondary probe
				</button>,
				'current'
			)
		);
		const secondary = getByRole( 'button', {
			name: 'Decorative secondary probe',
		} );
		const skinRoot = secondary.closest( '.newspack-nodes-skin-root' );
		const declarations = matchingDeclarations( secondary );
		const decorativeSkin = skinDeclarations( skinRoot, 'current' );

		expect( decorativeSkin[ '--button-secondary-border' ] ).toBeUndefined();
		expect( decorativeSkin[ '--button-secondary-color' ] ).toBeUndefined();
		expect( declarations[ 'border-color' ] ).toBe(
			'var(--button-secondary-border,var(--paper-shadow,var(--np-border-strong)))'
		);
		expectUsesSentinel(
			secondary,
			'border-color',
			'--paper-shadow',
			SENTINELS.shadow
		);
	} );

	it( 'renders a structural rail chevron through one neutral shared role', () => {
		const { container } = render(
			provider(
				<LogStreamViewer
					className="rail-role-probe"
					ariaLabel="Rail role probe"
					pickerOptions={ null }
					selectedKey=""
					onPick={ () => {} }
					isPaused={ false }
					connectionError={ false }
					onTogglePause={ () => {} }
					getViewNode={ () => null }
					sidebar={ <div>Sentinel rail</div> }
					renderRow={ () => null }
					rowHeight={ 47 }
				/>
			)
		);
		const toggle = container.querySelector( '.newspack-nodes-rail-toggle' );

		expect( toggle ).not.toBeNull();
		expect( toggle.classList.contains( 'button' ) ).toBe( false );
		expect( toggle.classList.contains( 'button-small' ) ).toBe( false );
		expect( matchingDeclarations( toggle ) ).toMatchObject( {
			background: 'var(--paper-2,var(--np-surface-subtle))',
			'border-color': 'var(--ink-4,var(--np-text-secondary))',
			'border-radius': '2px',
			color: 'var(--ink,var(--np-text))',
			'font-family': 'var(--font-mono,var(--np-font-mono))',
			'font-size': '12px',
			'font-weight': '700',
		} );
		expectUsesSentinel(
			toggle,
			'background',
			'--paper-2',
			SENTINELS.paper2
		);
		expectUsesSentinel( toggle, 'color', '--ink', SENTINELS.ink );
		expectUsesSentinel( toggle, 'border-color', '--ink-4', SENTINELS.ink4 );
		expectUsesSentinel(
			toggle,
			'font-family',
			'--font-mono',
			SENTINELS.fontMono
		);
	} );

	it( 'gives log browsing semantic modes, terminal rows, and a quiet empty state', () => {
		const { container: browser } = render(
			provider(
				<LogBrowser
					mode="live"
					onFollow={ () => {} }
					onReplay={ () => {} }
					items={ [] }
					onSelectItem={ () => {} }
					itemKey={ ( item ) => item.id }
					itemLabel={ ( item ) => item.id }
					title="Segments"
					emptyLabel="No segments probe 73"
				/>
			)
		);
		const live = browser.querySelector(
			'.newspack-nodes-log-browser__mode--live'
		);
		const replay = browser.querySelector(
			'.newspack-nodes-log-browser__mode--replay'
		);
		const empty = browser.querySelector(
			'.newspack-nodes-log-browser__empty'
		);

		expect( live ).not.toBeNull();
		expect( replay ).not.toBeNull();
		expect( live.classList.contains( 'button' ) ).toBe( false );
		expect( replay.classList.contains( 'button' ) ).toBe( false );
		expect( live.getAttribute( 'aria-pressed' ) ).toBe( 'true' );
		expect( replay.getAttribute( 'aria-pressed' ) ).toBe( 'false' );
		expect( matchingDeclarations( live ) ).toMatchObject( {
			background: 'var(--oxide,var(--np-error))',
			'border-color': 'var(--oxide,var(--np-error))',
			color: 'var(--on-oxide,var(--np-on-status))',
		} );
		// An idle mode button is a secondary button like any other, not a
		// bespoke transparent chip that shows the sidebar through it.
		expect( matchingDeclarations( replay ) ).toMatchObject( {
			background:
				'var(--button-secondary-background,var(--paper,var(--np-surface)))',
			'border-color':
				'var(--button-secondary-border,var(--paper-shadow,var(--np-border-strong)))',
			color: 'var(--button-secondary-color,var(--ink,var(--np-text)))',
		} );
		expectUsesSentinel( live, 'background', '--oxide', SENTINELS.oxide );
		expectUsesSentinel(
			replay,
			'border-color',
			'--button-secondary-border',
			SENTINELS.secondaryBorder
		);
		expectUsesSentinel(
			replay,
			'color',
			'--button-secondary-color',
			SENTINELS.secondaryColor
		);
		expect( matchingDeclarations( empty ) ).toMatchObject( {
			background: 'transparent',
			border: '0',
			'box-shadow': 'none',
			'font-style': 'italic',
		} );

		expect(
			declarationsForSelector( '.newspack-nodes-log-row' )[
				'font-family'
			]
		).toBe( 'var(--font-terminal,var(--np-font-mono))' );
		expect( fs.readFileSync( LOG_VIEWER, 'utf8' ) ).not.toMatch(
			/newspack-nodes-table__row\s+newspack-nodes-table__cell\s+newspack-nodes-log-row/
		);
	} );

	// A glyph sitting beside stock chrome (a modal close) is not a button with
	// its box removed — it takes the surrounding ink and never underlines.
	it( 'gives a plain button no box, ink text, and no link decoration', () => {
		const { container } = render(
			provider(
				<button type="button" className="button is-plain">
					←
				</button>
			)
		);
		const plain = container.querySelector( '.button.is-plain' );

		expect( matchingDeclarations( plain ) ).toMatchObject( {
			background: 'transparent',
			'border-color': 'transparent',
		} );
		expectUsesSentinel( plain, 'color', '--ink', SENTINELS.ink );
		expect(
			pseudoRuleReaches( plain, ':hover', {
				'text-decoration': 'underline',
			} )
		).toBe( false );
	} );

	// Value and label are adjacent inline spans; with no gap they read as one
	// token ("34Unique URLs").
	it( 'separates a stat value from the label that follows it', () => {
		const { container } = render(
			provider(
				<div className="newspack-nodes-stat">
					<span className="newspack-nodes-stat-value">34</span>
					<span className="newspack-nodes-stat-label">
						Unique URLs
					</span>
				</div>
			)
		);

		expect(
			matchingDeclarations(
				container.querySelector( '.newspack-nodes-stat-label' )
			)[ 'margin-left' ]
		).toBe( '8px' );
	} );

	// A label is painted because it labels a control, not because a modal
	// happens to contain it. Outside one, WordPress's own #646970 shows through.
	it( 'paints control labels and help text from the skin, modal or not', () => {
		const { container } = render(
			provider(
				<div>
					<div className="components-base-control">
						<label
							className="components-base-control__label"
							htmlFor="probe-metric"
						>
							Metric
						</label>
						<select id="probe-metric">
							<option>Request Volume</option>
						</select>
						<p className="components-base-control__help">
							Which series to chart.
						</p>
					</div>
					<table className="form-table">
						<tbody>
							<tr>
								<th>
									<label htmlFor="probe-id">ID</label>
								</th>
								<td>
									<input
										id="probe-id"
										className="regular-text"
										readOnly
									/>
									<p className="description">
										Unique identifier.
									</p>
								</td>
							</tr>
						</tbody>
					</table>
				</div>
			)
		);

		const wpLabel = container.querySelector(
			'.components-base-control__label'
		);
		const wpHelp = container.querySelector(
			'.components-base-control__help'
		);
		const adminLabel = container.querySelector( '.form-table label' );
		const adminHelp = container.querySelector( '.description' );

		expect( [ wpLabel, wpHelp, adminLabel, adminHelp ] ).not.toContain(
			null
		);
		// Softer than body ink, still a step above the help text below it.
		expectUsesSentinel( wpLabel, 'color', '--ink-2', SENTINELS.ink2 );
		expectUsesSentinel( wpHelp, 'color', '--ink-3', SENTINELS.ink3 );
		expectUsesSentinel( adminLabel, 'color', '--ink-2', SENTINELS.ink2 );
		expectUsesSentinel( adminHelp, 'color', '--ink-3', SENTINELS.ink3 );
	} );

	it( 'browses segments as flat rows with a subtle selection, not stock button chrome', () => {
		const { container: browser } = render(
			provider(
				<LogBrowser
					mode="replay"
					onFollow={ () => {} }
					onReplay={ () => {} }
					items={ [ { id: 1249 }, { id: 1250 } ] }
					selectedKey={ 1250 }
					onSelectItem={ () => {} }
					itemKey={ ( item ) => item.id }
					itemLabel={ ( item ) => `Segment ${ item.id }` }
					itemMeta={ () => '1.0 MB' }
					title="Segments"
					emptyLabel="No segments"
				/>
			)
		);
		const rows = browser.querySelectorAll(
			'.newspack-nodes-log-browser__item'
		);
		const [ row, selected ] = rows;

		// A segment row is a list row, not a competitor to the stock button.
		expect( row.classList.contains( 'button' ) ).toBe( false );
		expect( matchingDeclarations( row ) ).toMatchObject( {
			background: 'transparent',
			border: '0',
			color: 'var(--ink,var(--np-text))',
		} );
		expectUsesSentinel( row, 'color', '--ink', SENTINELS.ink );

		expect( selected.classList.contains( 'is-active' ) ).toBe( true );
		expect( matchingDeclarations( selected ) ).toMatchObject( {
			background: 'var(--cyan-subtle,var(--np-primary-subtle))',
			'font-weight': '600',
		} );
		expectUsesSentinel(
			selected,
			'background',
			'--cyan-subtle',
			SENTINELS.cyanSubtle
		);
	} );

	it( 'renders the debug launcher and panel through their existing canonical classes', () => {
		registerDevtoolsTab( {
			id: 'probe',
			label: 'Probe',
			host: 'overlay',
			component: () => <div>Probe panel</div>,
		} );
		const { getByRole, getByTestId } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		const fab = getByRole( 'button', { name: /debug/i } );
		expect( fab.classList.contains( 'nodes-debug__fab' ) ).toBe( true );
		expect( fab.classList.contains( 'button' ) ).toBe( false );
		expect( matchingDeclarations( fab ) ).toMatchObject( {
			background: 'var(--repl-bg,var(--np-text))',
			'border-radius': '50%',
			'box-shadow': '0 2px 10px rgba(0,0,0,0.35)',
			color: 'var(--repl-fg,var(--np-surface))',
		} );

		fireEvent.click( fab );
		const panel = getByTestId( 'debug-panel' );
		expect( panel.classList.contains( 'nodes-debug__panel' ) ).toBe( true );
		expect( panel.classList.contains( 'newspack-nodes-card' ) ).toBe(
			false
		);
		expect( matchingDeclarations( panel ) ).toMatchObject( {
			background: 'var(--paper-3,var(--np-surface-muted))',
			border: '1px solid var(--paper-shadow,var(--np-border-strong))',
			'border-radius': '10px',
			'box-shadow': '0 8px 40px rgba(0,0,0,0.45)',
		} );
	} );

	it( 'keeps segmented modes, modal closes, and REPL controls out of the generic button cascade', () => {
		const { container: header } = render(
			provider(
				<Header
					mode="view"
					streamStatus="open"
					onModeChange={ () => {} }
					onNew={ () => {} }
					onOpen={ () => {} }
					onSave={ () => {} }
				/>
			)
		);
		const mode = header.querySelector( '.topology-mode' );
		const live = header.querySelector( '.topology-mode__btn--live' );
		expect( live.classList.contains( 'topology-mode__btn' ) ).toBe( true );
		expect( live.classList.contains( 'button' ) ).toBe( false );
		expect( matchingDeclarations( mode ).border ).toBe(
			'1px solid var(--ink,var(--np-text))'
		);
		expect( matchingDeclarations( live ) ).toMatchObject( {
			background: 'var(--oxide,var(--np-error))',
			color: 'var(--on-oxide,var(--np-on-status))',
		} );

		const { baseElement } = render(
			<ModalShell title="Cascade probe 83" onDismiss={ () => {} }>
				<div />
			</ModalShell>
		);
		const close = baseElement.querySelector(
			'.newspack-nodes-modal__close'
		);
		expect( close.classList.contains( 'button' ) ).toBe( false );
		expect( matchingDeclarations( close ) ).toMatchObject( {
			background: 'transparent',
			border: '1px solid transparent',
			color: 'var(--ink,var(--np-text))',
		} );

		const { container: repl } = render(
			provider(
				<ReplFooter
					prompt="/probe"
					streamStatus="open"
					canSend
					onSubmit={ () => {} }
					onClear={ () => {} }
					transcript={ [] }
					expanded
					onExpandedChange={ () => {} }
				/>
			)
		);
		const terminalControls = [
			...repl.querySelectorAll(
				'.topology-repl__toggle, .topology-repl__clear'
			),
		];
		expect( terminalControls.length ).toBeGreaterThan( 0 );
		for ( const control of terminalControls ) {
			expect( control.classList.contains( 'button' ) ).toBe( false );
			expect( matchingDeclarations( control ) ).toMatchObject( {
				background: 'var(--repl-bg,var(--np-text))',
				'border-color':
					'color-mix(in srgb,var(--repl-fg,var(--np-surface)) 25%,transparent)',
				color: 'color-mix(in srgb,var(--repl-fg,var(--np-surface)) 55%,transparent)',
			} );
			expectUsesSentinel(
				control,
				'border-color',
				'--repl-fg',
				SENTINELS.replForeground
			);
		}
		expect(
			declarationsForSelector( '.topology-repl__toggle:hover' )
		).toMatchObject( {
			'border-color': 'var(--brass,var(--np-warning))',
			color: 'var(--brass,var(--np-warning))',
		} );
		expect(
			declarationsForSelector( '.topology-repl__clear:hover' )
		).toMatchObject( {
			'border-color': 'var(--oxide,var(--np-error))',
			color: 'var(--oxide,var(--np-error))',
		} );
	} );
} );
