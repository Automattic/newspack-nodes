/**
 * The console's machine-data surfaces read in the terminal face under every
 * skin: the sortable grid behind the Profiler, Runtime and per-verb stats and
 * the panes around it, the Timeline trace table, and the REPL with its
 * transcript and controls. The grid's numeric columns right-align on tabular
 * digits while its name columns stay left.
 *
 * The structural checks run under the Newspack skin, whose `--font-mono` is
 * Inter, so a surface reading that token instead of `--font-terminal` fails.
 */

import path from 'path';
import * as sass from 'sass';
import postcss from 'postcss';
import { render } from '@testing-library/react';
import { THEMES } from '../../../shared/theme';
import { Grid } from '../SortableGrid';
import TimelineView from '../TimelineView';
import ReplFooter from '../ReplFooter';

const read = require( '../../../build-kit/css-reader.cjs' );

const ROOT = path.resolve( __dirname, '../../../..' );
const SHEETS = [
	'src/theme/newspack-theme.scss',
	'src/ui/newspack-nodes-ui.scss',
	'src/topology-console/styles/graph-view.scss',
	'src/topology-console/components/inspector-views.scss',
	'src/topology-console/components/timeline-view.scss',
].map( ( sheet ) =>
	postcss.parse( sass.compile( path.join( ROOT, sheet ) ).css )
);
const OPTIONS = { isSizeVar: ( w ) => w.startsWith( 'var(--np-text-' ) };
const SKINS = THEMES.map( ( { slug } ) => slug );
const ROLE_FAMILY = 'var(--font-terminal, var(--np-font-mono))';

/**
 * An element's font family, every token resolved, read up the ancestry while
 * the element inherits it.
 *
 * @param {Element} element The element.
 * @return {string|undefined} The family list.
 */
const fontFamily = ( element ) => {
	for ( let node = element; node; node = node.parentElement ) {
		const family = read.computed( node, 'font-family', SHEETS, OPTIONS );
		if ( undefined !== family && 'inherit' !== family ) {
			return family;
		}
	}
	return undefined;
};

const isMonospace = ( family ) =>
	'monospace' ===
	read
		.splitTopLevel( family ?? '', ( ch ) => ',' === ch )
		.pop()
		?.trim();

// The modal portal wears the skin root alone; the REPL sits in the console.
const modal = ( child, skin = 'newspack' ) =>
	render(
		<div className={ `theme-${ skin }` }>
			<div className="newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui">
				{ child }
			</div>
		</div>
	).container;

const COLS = [
	{ key: 'what', label: 'WHAT' },
	{ key: 'avg', label: 'AVERAGE', numeric: true },
	{ key: 'count', label: 'COUNT', numeric: true },
];
const ROWS = [
	{ name: 'probe:alpha', what: 'probe:alpha', avg: 0.004217, count: 731 },
	{ name: 'probe:beta', what: 'probe:beta', avg: 0.000913, count: 58 },
];

const grid = () =>
	modal(
		<Grid
			testid="probe-grid"
			cols={ COLS }
			rows={ ROWS }
			sort={ { key: 'avg', dir: 'desc' } }
			onSort={ () => {} }
			footer={ { what: '--total--', avg: 0.00513, count: 789 } }
		/>
	);

/**
 * One column's header, body cells and footer cell.
 *
 * @param {Element} container The rendered grid.
 * @param {string}  key       The column key.
 * @return {Element[]} Its cells, header first.
 */
const column = ( container, key ) => {
	const header = container.querySelector(
		`[data-testid="probe-grid-th-${ key }"]`
	);
	const at = [ ...header.parentElement.children ].indexOf( header );
	return [
		header,
		...[ ...container.querySelectorAll( 'tbody tr, tfoot tr' ) ].map(
			( row ) => row.children[ at ]
		),
	];
};

describe( 'machine-data surfaces read in the terminal face', () => {
	it.each( SKINS )(
		'the %s skin resolves --font-terminal to a monospace stack',
		( skin ) => {
			const root = modal( <span />, skin ).querySelector(
				'.newspack-nodes-skin-root'
			);
			expect(
				isMonospace( read.computed( root, '--font-terminal', SHEETS ) )
			).toBe( true );
		}
	);

	it( 'sets every grid cell in the shared terminal-data role', () => {
		const cells = grid().querySelectorAll( 'th, td' );
		expect( cells ).toHaveLength( 12 );
		for ( const cell of cells ) {
			expect( read.winning( cell, 'font-family', SHEETS, OPTIONS ) ).toBe(
				ROLE_FAMILY
			);
			expect( fontFamily( cell ) ).toMatch( /^"JetBrains Mono"/ );
		}
	} );

	it( 'sets the Runtime and Profiler panes in the terminal face', () => {
		const panes = modal(
			<>
				<div className="nodes-runtime">
					<h3 className="nodes-runtime__title">Timers</h3>
				</div>
				<div className="nodes-profiler" />
			</>
		);
		for ( const pane of panes.querySelectorAll(
			'.nodes-runtime, .nodes-runtime__title, .nodes-profiler'
		) ) {
			expect( isMonospace( fontFamily( pane ) ) ).toBe( true );
		}
	} );

	it( 'sets the Timeline header and rows in the terminal face', () => {
		const cells = modal(
			<TimelineView
				transcript={ [
					{
						key: 'e1',
						ts: 1763000000,
						text: 'probe:alpha: DEBUG: CONNECTED handle=41',
					},
				] }
			/>
		).querySelectorAll( '.timeline-view__col, .timeline-view__cell' );
		expect( cells ).toHaveLength( 8 );
		for ( const cell of cells ) {
			expect( isMonospace( fontFamily( cell ) ) ).toBe( true );
		}
	} );

	it( 'sets the REPL, its controls and its transcript in the terminal face', () => {
		const { container } = render(
			<div className="theme-newspack">
				<div className="topology-app newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui">
					<ReplFooter
						prompt="/probe"
						streamStatus="open"
						canSend
						onSubmit={ () => {} }
						onClear={ () => {} }
						transcript={ [
							{ key: 's1', kind: 'sent', text: 'ls -l' },
							{
								key: 'r1',
								kind: 'recv',
								text: 'probe:alpha  Tee',
							},
						] }
						expanded
						onExpandedChange={ () => {} }
					/>
				</div>
			</div>
		);
		const parts = container.querySelectorAll(
			'.topology-repl__input, .topology-repl__entry, .topology-repl__toggle, .topology-repl__clear'
		);
		expect( parts.length ).toBeGreaterThanOrEqual( 5 );
		for ( const part of parts ) {
			expect( isMonospace( fontFamily( part ) ) ).toBe( true );
		}
	} );
} );

describe( 'the grid aligns each column by its declared kind', () => {
	it.each( [ 'avg', 'count' ] )(
		'right-aligns the numeric %s column on tabular digits, header included',
		( key ) => {
			for ( const cell of column( grid(), key ) ) {
				expect( read.computed( cell, 'text-align', SHEETS ) ).toBe(
					'right'
				);
				expect(
					read.computed( cell, 'font-variant-numeric', SHEETS )
				).toBe( 'tabular-nums' );
			}
		}
	);

	it( 'keeps the name column left-aligned, header included', () => {
		for ( const cell of column( grid(), 'what' ) ) {
			expect( read.computed( cell, 'text-align', SHEETS ) ).toBe(
				'left'
			);
			expect(
				read.computed( cell, 'font-variant-numeric', SHEETS )
			).toBeUndefined();
		}
	} );
} );
