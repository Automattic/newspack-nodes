/* @jest-environment node */

/* global NEWSPACK_NODES_SRC */
import fs from 'fs';
import path from 'path';
import * as sass from 'sass';
// Babel/Jest already installs the parser used for source-level JSX ownership.
// eslint-disable-next-line import/no-extraneous-dependencies
import { parse as parseJavaScript } from '@babel/parser';
import postcss from 'postcss';
import scss from 'postcss-scss';

const NODES_SRC = path.resolve( __dirname, '../../..' );
const UI_ENTRY = path.join( NODES_SRC, 'ui/newspack-nodes-ui.scss' );
const GRAPH_VIEW = path.join(
	NODES_SRC,
	'topology-console/styles/graph-view.scss'
);
const INSPECTOR_VIEWS = path.join(
	NODES_SRC,
	'topology-console/components/inspector-views.scss'
);
const TRIAGE_VIEW = path.join(
	NODES_SRC,
	'topology-console/components/triage-view.scss'
);
const { sassImporter } = require( '../../../build-kit/alias-map.cjs' );

// The aliases resolved against the base the jest config hands every test.
const SHARED_IMPORTER = sassImporter( NEWSPACK_NODES_SRC );
const graphStylesheet = postcss.parse(
	sass.compile( GRAPH_VIEW, { importers: [ SHARED_IMPORTER ] } ).css,
	{ from: GRAPH_VIEW }
);
const inspectorViewsStylesheet = postcss.parse(
	sass.compile( INSPECTOR_VIEWS ).css,
	{ from: INSPECTOR_VIEWS }
);
const triageViewStylesheet = postcss.parse( sass.compile( TRIAGE_VIEW ).css, {
	from: TRIAGE_VIEW,
} );
const EMITTING_PARTIALS = new Set( [
	'focus',
	'controls',
	'inputs',
	'components',
	'buttons',
	'toolbar',
	'modal',
	'distinctive-roles',
] );
const IMPORT_AT_RULES = new Set( [ 'use', 'import', 'forward' ] );
const FOCUS_OWNERS = new Set( [
	path.join( NODES_SRC, 'shared/styles/_focus.scss' ),
	path.join( NODES_SRC, 'theme/_legacy-focus.scss' ),
] );
const FOCUS_SELECTOR = /:focus(?:-visible|-within)?/;
const RAW_SEMANTIC_TEXT =
	/(?:var\(--(?:cyan|cyan-dark|brass|brass-dark|sage|sage-dark|oxide|oxide-dark)(?:\s*[,)]))|(?:var\(--np-(?:primary|primary-hover|warning|success|error)(?:\s*[,)]))|(?:color-mix\([^;]*(?:--cyan|--brass|--sage|--oxide))|#(?:d63638|dba617|4caf50|64b5f6|ff9800|ef5350)\b/i;
const CANONICAL_STYLE_ROOTS = [
	path.join( NODES_SRC, 'shared/styles' ),
	path.join( NODES_SRC, 'theme' ),
	path.join( NODES_SRC, 'ui' ),
];
const CANONICAL_BUTTON_CLASSES = new Set( [
	'button',
	'button-primary',
	'button-small',
	'button-link',
	'button-link-delete',
	'nodes-tab-host__tab',
	'nodes-debug__fab',
	'newspack-nodes-log-browser__mode',
	'newspack-nodes-log-browser__mode--live',
	'newspack-nodes-log-browser__mode--replay',
	'newspack-nodes-log-browser__item',
	'newspack-nodes-chart-legend__item',
	'newspack-nodes-chart__stack',
	'newspack-nodes-chart__expand',
	'newspack-nodes-modal__close',
	'newspack-nodes-disclosure',
	'newspack-nodes-rail-toggle',
	'topology-mode__btn',
	'topology-repl__toggle',
	'topology-repl__clear',
] );
const REQUIRED_ROLE_PAIRS = [
	[ 'nodes-card', 'newspack-nodes-card' ],
	[ 'nodes-card', 'newspack-nodes-stat-tile' ],
	[ 'nodes-cards', 'newspack-nodes-stats-grid' ],
	[ 'nodes-card__value', 'newspack-nodes-stat-value' ],
	[ 'nodes-card__label', 'newspack-nodes-stat-label' ],
	[ 'nodes-topics', 'newspack-nodes-card' ],
	[ 'newspack-nodes-chart__tooltip', 'newspack-nodes-card' ],
	[ 'newspack-nodes-chart__tooltip', 'newspack-nodes-card--elevated' ],
	[ 'nodes-overview__stopped-item', 'newspack-nodes-badge' ],
	[ 'nodes-tm__topology', 'newspack-nodes-card' ],
	[ 'nodes-tm__expand', 'newspack-nodes-disclosure' ],
	[ 'nodes-tm__collapse', 'newspack-nodes-disclosure' ],
	[ 'caret', 'newspack-nodes-disclosure' ],
	[ 'nodes-tm__badge', 'newspack-nodes-status-badge' ],
	[ 'nodes-tm__badge', 'is-pill' ],
	[ 'aggregator-server-card', 'newspack-nodes-card' ],
	[ 'aggregator-server-card', 'newspack-nodes-card--elevated' ],
	[ 'aggregator-stat-value', 'newspack-nodes-stat-value' ],
	[ 'nodes-runtime__grid', 'newspack-nodes-table' ],
	[ 'topology-modal', 'newspack-nodes-modal' ],
	[ 'topology-settings-panel', 'newspack-nodes-card' ],
	[ 'topology-settings-panel', 'newspack-nodes-card--elevated' ],
	[ 'topology-open-item__badge', 'newspack-nodes-badge' ],
	[ 'nodes-tm__alert', 'newspack-nodes-modal' ],
	[ 'nodes-station__empty', 'newspack-nodes-empty-state' ],
	[ 'nodes-station__lazy-loading', 'newspack-nodes-performance-loading' ],
	[ 'aggregator-status-loading', 'newspack-nodes-performance-loading' ],
	[ 'aggregator-status-empty', 'newspack-nodes-empty-state' ],
	[ 'nodes-probe-tab__empty', 'newspack-nodes-empty-state' ],
	[ 'nodes-config-audit__empty', 'newspack-nodes-empty-state' ],
	[ 'newspack-nodes-log-browser__empty', 'newspack-nodes-empty-state' ],
	[ 'newspack-nodes-log-browser__empty', 'is-quiet' ],
	[ 'newspack-nodes-log-rows', 'newspack-nodes-table' ],
	[ 'newspack-nodes-log-header', 'newspack-nodes-table__header' ],
	[ 'newspack-nodes-log-header__th', 'newspack-nodes-table__cell' ],
	[ 'newspack-nodes-log-row', 'newspack-nodes-table__row' ],
	[ 'newspack-nodes-log-row__id', 'newspack-nodes-table__cell' ],
	[ 'newspack-nodes-log-row__key', 'newspack-nodes-table__cell' ],
	[ 'newspack-nodes-log-row__value', 'newspack-nodes-table__cell' ],
	[ 'newspack-nodes-log-browser__item-meta', 'newspack-nodes-status' ],
	[ 'newspack-nodes-log-rows__empty', 'newspack-nodes-empty-state' ],
	[ 'newspack-nodes-log-rows__empty', 'is-quiet' ],
	[ 'topology-tt__empty', 'newspack-nodes-empty-state' ],
	[ 'triage-view__empty', 'newspack-nodes-empty-state' ],
	[ 'timeline-view__empty', 'newspack-nodes-empty-state' ],
	[ 'topology-insp__empty', 'newspack-nodes-empty-state' ],
	[ 'nodes-jobs__status', 'newspack-nodes-status-badge' ],
	[ 'worker-status-badge', 'newspack-nodes-status-badge' ],
	[ 'nodes-tm__health', 'newspack-nodes-status' ],
	[ 'nodes-tm__health', 'newspack-nodes-status-indicator' ],
	[ 'aggregator-status-badge', 'newspack-nodes-status-badge' ],
	[ 'aggregator-response-badge', 'newspack-nodes-status-badge' ],
	[ 'aggregator-partition-error', 'newspack-nodes-status-badge' ],
	[ 'aggregator-rtt', 'newspack-nodes-status' ],
	[ 'topology-repl__status', 'newspack-nodes-status' ],
	[ 'topology-inspector__toggle', 'newspack-nodes-rail-toggle' ],
	[ 'topology-palette__toggle', 'newspack-nodes-rail-toggle' ],
	[ 'triage-view__status', 'newspack-nodes-status' ],
	[ 'test-status', 'newspack-nodes-status' ],
	[ 'nodes-vault__save-status', 'newspack-nodes-status' ],
	[ 'newspack-nodes-connection-banner', 'newspack-nodes-error-banner' ],
];
const SURFACE_SELECTORS = new Set( [
	'.nodes-card',
	'.nodes-debug__panel',
	'.nodes-topics',
	'.newspack-nodes-chart__tooltip',
	'.nodes-overview__stopped-item',
	'.nodes-tm__topology',
	'.nodes-tm__badge',
	'.aggregator-server-card',
	'.nodes-tm__alert',
	'.topology-modal',
	'.topology-settings-panel',
	'.topology-open-item__badge',
	'.newspack-nodes-connection-banner',
	'.newspack-nodes-log-rows',
	'.newspack-nodes-log-header',
	'.newspack-nodes-log-header__th',
	'.newspack-nodes-log-row',
	'.nodes-runtime__grid',
] );
const APPEARANCE_PROPERTY =
	/^(?:-webkit-appearance|appearance|background(?:-.+)?|border(?:-.+)?|box-shadow|color|cursor|filter|font|font-family|font-weight|letter-spacing|opacity|outline(?:-.+)?|text-decoration(?:-.+)?|text-shadow|text-transform)$/;
const isAppearanceProperty = ( property ) =>
	! [ 'border-collapse', 'border-spacing' ].includes( property ) &&
	APPEARANCE_PROPERTY.test( property );
const walkScss = ( root ) =>
	fs.readdirSync( root, { withFileTypes: true } ).flatMap( ( entry ) => {
		const absolute = path.join( root, entry.name );
		if ( entry.isDirectory() ) {
			return '__tests__' === entry.name ? [] : walkScss( absolute );
		}
		return entry.name.endsWith( '.scss' ) ? [ absolute ] : [];
	} );

const walkJavaScript = ( root ) =>
	fs.readdirSync( root, { withFileTypes: true } ).flatMap( ( entry ) => {
		const absolute = path.join( root, entry.name );
		if ( entry.isDirectory() ) {
			return '__tests__' === entry.name ? [] : walkJavaScript( absolute );
		}
		return /\.(?:js|jsx)$/.test( entry.name ) ? [ absolute ] : [];
	} );

const sourceFiles = () => walkScss( NODES_SRC ).sort();

const parse = ( file ) =>
	scss.parse( fs.readFileSync( file, 'utf8' ), { from: file } );

const compile = ( file ) =>
	postcss.parse(
		sass.compile( file, { importers: [ SHARED_IMPORTER ] } ).css,
		{ from: file }
	);

const walkAst = ( node, visit ) => {
	if ( ! node || 'object' !== typeof node ) {
		return;
	}
	visit( node );
	for ( const [ key, value ] of Object.entries( node ) ) {
		if (
			[ 'comments', 'end', 'extra', 'loc', 'start', 'tokens' ].includes(
				key
			)
		) {
			continue;
		}
		if ( Array.isArray( value ) ) {
			value.forEach( ( child ) => walkAst( child, visit ) );
		} else {
			walkAst( value, visit );
		}
	}
};

const classTokens = ( attribute ) => {
	const tokens = new Set();
	walkAst( attribute?.value, ( node ) => {
		let value;
		if ( 'StringLiteral' === node.type ) {
			value = node.value;
		} else if ( 'TemplateElement' === node.type ) {
			value = node.value.cooked ?? node.value.raw;
		}
		for ( const token of String( value ?? '' ).split( /\s+/ ) ) {
			if ( token ) {
				tokens.add( token );
			}
		}
	} );
	return tokens;
};

const jsxClassRecords = () => {
	const records = [];
	for ( const file of walkJavaScript( NODES_SRC ).sort() ) {
		const source = fs.readFileSync( file, 'utf8' );
		const ast = parseJavaScript( source, {
			sourceType: 'module',
			plugins: [ 'jsx' ],
		} );
		walkAst( ast, ( node ) => {
			if ( 'JSXOpeningElement' !== node.type ) {
				return;
			}
			const attribute = node.attributes.find(
				( candidate ) =>
					'JSXAttribute' === candidate.type &&
					'className' === candidate.name?.name
			);
			records.push( {
				attribute,
				attributeSource: attribute
					? source.slice( attribute.start, attribute.end )
					: '',
				file,
				line: node.loc.start.line,
				styleSource: node.attributes
					.filter(
						( candidate ) =>
							'JSXAttribute' === candidate.type &&
							'style' === candidate.name?.name
					)
					.map( ( candidate ) =>
						source.slice( candidate.start, candidate.end )
					)
					.join( ' ' ),
				tag: 'JSXIdentifier' === node.name.type ? node.name.name : '',
				tokens: classTokens( attribute ),
			} );
		} );
	}
	return records;
};

const selectorHasClass = ( selector, className ) =>
	new RegExp(
		`\\.${ className.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ) }(?![\\w-])`
	).test( selector );

const isComponentClass = ( className ) =>
	! CANONICAL_BUTTON_CLASSES.has( className ) &&
	! className.startsWith( 'is-' ) &&
	/[A-Za-z]/.test( className );

const hasPrimaryButtonHelper = ( attribute ) => {
	let found = false;
	walkAst( attribute?.value, ( node ) => {
		if (
			'Identifier' === node.type &&
			'primaryButtonClass' === node.name
		) {
			found = true;
		}
	} );
	return found;
};

const importTargets = ( params ) =>
	[ ...params.matchAll( /(["'])(.*?)\1/g ) ].map( ( match ) => match[ 2 ] );

const partialName = ( target ) =>
	path.posix
		.basename( target.replaceAll( '\\', '/' ) )
		.replace( /^_/, '' )
		.replace( /\.scss$/, '' );

const isFocusProperty = ( property ) =>
	/^outline(?:-|$)/.test( property ) ||
	'box-shadow' === property ||
	'border-color' === property;

// A numeric top-level `const` read out of a module's SOURCE. This file runs in
// the node environment, so a component carrying the number cannot be imported;
// its AST is how that number is held to the stylesheet it was copied from.
const numericConstant = ( file, name ) => {
	const ast = parseJavaScript( fs.readFileSync( file, 'utf8' ), {
		sourceType: 'module',
		plugins: [ 'jsx' ],
	} );
	let value;
	walkAst( ast, ( node ) => {
		if (
			'VariableDeclarator' === node.type &&
			name === node.id?.name &&
			'NumericLiteral' === node.init?.type
		) {
			value = node.init.value;
		}
	} );
	expect( value ).toEqual( expect.any( Number ) );
	return value;
};

// A layer token, read from the scale that declares it.
const layerToken = ( name ) => {
	const source = fs.readFileSync(
		path.join( NODES_SRC, 'shared/styles/_tokens.scss' ),
		'utf8'
	);
	return Number(
		source.match( new RegExp( `\\$${ name }:\\s*(\\d+);` ) )[ 1 ]
	);
};

// The dark skins, read from the stylesheet that declares them, so the list
// cannot drift between the SCSS and the expectation pinning it.
const darkSkins = () => {
	const source = fs.readFileSync(
		path.join( NODES_SRC, 'shared/styles/_controls.scss' ),
		'utf8'
	);
	const declaration = source.match( /\$np-dark-skins:\s*([^;]+);/ );
	return declaration[ 1 ].split( ',' ).map( ( skin ) => skin.trim() );
};

// The scope every pick paint nests under, which keeps the page box out.
const PICK =
	':where(html).newspack-nodes-asking :where(.newspack-nodes-ui) [data-ask][data-ask-picked]:not([data-ask-page])';

// Each declaration of the LAST rule naming `selector`, with its `!important`.
const declarationsWithImportance = ( stylesheet, selector ) => {
	let declarations;
	stylesheet.walkRules( ( rule ) => {
		if ( rule.selectors.includes( selector ) ) {
			declarations = Object.fromEntries(
				rule.nodes
					.filter( ( node ) => 'decl' === node.type )
					.map( ( declaration ) => [
						declaration.prop,
						{
							value: declaration.value,
							important: Boolean( declaration.important ),
						},
					] )
			);
		}
	} );
	return declarations;
};

const declarationsForSelector = ( stylesheet, selector ) => {
	const declarations = declarationsWithImportance( stylesheet, selector );
	return (
		declarations &&
		Object.fromEntries(
			Object.entries( declarations ).map( ( [ prop, { value } ] ) => [
				prop,
				value,
			] )
		)
	);
};

const mergedDeclarationsForSelectors = ( stylesheet, predicate ) => {
	let found = false;
	const declarations = {};
	stylesheet.walkRules( ( rule ) => {
		if ( ! rule.selectors.some( predicate ) ) {
			return;
		}
		found = true;
		for ( const declaration of rule.nodes.filter(
			( node ) => 'decl' === node.type
		) ) {
			declarations[ declaration.prop ] = declaration.value;
		}
	} );
	return found ? declarations : undefined;
};

const declarationsForRepeatedButtonClass = ( stylesheet, className ) =>
	mergedDeclarationsForSelectors(
		stylesheet,
		( selector ) =>
			selector.startsWith( '.newspack-nodes-ui.newspack-nodes-ui' ) &&
			selectorHasClass( selector, 'button' ) &&
			selectorHasClass( selector, className )
	);

const consumerStylesheets = () =>
	walkScss( NODES_SRC )
		.filter(
			( file ) =>
				! CANONICAL_STYLE_ROOTS.some(
					( root ) => file === root || file.startsWith( `${ root }/` )
				)
		)
		.map( ( file ) => [ file, compile( file ) ] );

const STATUS_PILL_STRUCTURE_PROPERTIES = new Set( [
	'display',
	'padding',
	'border-radius',
	'font-size',
	'font-weight',
	'text-transform',
	'letter-spacing',
] );

const statusPillOwnershipOffenders = (
	stylesheet,
	relativeFile,
	selectors
) => {
	const offenders = [];
	const isWorkerStatus =
		'event-dashboards/styles/worker-status.scss' === relativeFile;
	stylesheet.walkRules( ( rule ) => {
		for ( const selector of rule.selectors ) {
			const ownsWorkerBadge =
				isWorkerStatus &&
				selectorHasClass( selector, 'worker-status-badge' );
			if ( ! ownsWorkerBadge && ! selectors.includes( selector ) ) {
				continue;
			}
			for ( const declaration of rule.nodes.filter(
				( node ) => 'decl' === node.type
			) ) {
				if (
					STATUS_PILL_STRUCTURE_PROPERTIES.has( declaration.prop ) ||
					( ownsWorkerBadge &&
						isAppearanceProperty( declaration.prop ) )
				) {
					offenders.push(
						`${ relativeFile }:${ selector }:${ declaration.prop }`
					);
				}
			}
		}
	} );
	return offenders;
};

describe( 'canonical appearance ownership', () => {
	it( 'rejects synthetic worker-badge paint in base and focus states', () => {
		const relativeFile = 'event-dashboards/styles/worker-status.scss';
		const stylesheet = postcss.parse(
			`
				.worker-status-badge {
					background: #fef102;
					color: #152947;
					border: 7px double #7b4a91;
					box-shadow: 13px 17px #ca315c;
				}
				.worker-status-badge:focus-visible {
					outline: 11px dotted #1267d3;
					border-color: #8842ce;
				}
			`,
			{ from: `${ relativeFile }#synthetic` }
		);

		expect(
			statusPillOwnershipOffenders( stylesheet, relativeFile, [
				'.worker-status-badge',
				'.worker-status-badge.small',
				'.worker-status-badge.compact',
			] )
		).toEqual( [
			`${ relativeFile }:.worker-status-badge:background`,
			`${ relativeFile }:.worker-status-badge:color`,
			`${ relativeFile }:.worker-status-badge:border`,
			`${ relativeFile }:.worker-status-badge:box-shadow`,
			`${ relativeFile }:.worker-status-badge:focus-visible:outline`,
			`${ relativeFile }:.worker-status-badge:focus-visible:border-color`,
		] );
	} );

	/**
	 * WordPress 7.0's `.wp-core-ui .button`, its admin text field and a
	 * `__next40pxDefaultSize` component all stand 40px tall; the control
	 * height token names that, so a chip sized by it lines up beside them.
	 */
	it( "names WordPress's 40px control height as the control-height token", () => {
		const css = sass.compileString(
			'@use "tokens"; a { min-height: tokens.$control-height; }',
			{ loadPaths: [ path.join( NODES_SRC, 'shared/styles' ) ] }
		).css;

		expect( css ).toContain( 'min-height: 40px;' );
	} );

	it( 'forwards the shared aggregator tokens rather than redeclaring them', () => {
		const stylesDir = path.join( NODES_SRC, 'event-aggregator/styles' );
		const basePath = path.join( stylesDir, 'base.scss' );
		const baseSource = fs.readFileSync( basePath, 'utf8' );
		const forwarded = [
			...baseSource.matchAll( /^@forward\s+"([^"]+)";/gm ),
		].map( ( match ) => match[ 1 ] );

		expect( forwarded ).toEqual( [
			'@newspack-nodes/shared/styles/tokens',
			'@newspack-nodes/shared/styles/mixins',
		] );
		expect( baseSource ).not.toMatch( /^\$[\w-]+\s*:/m );
		for ( const consumerPath of walkScss( stylesDir ).filter(
			( file ) => file !== basePath
		) ) {
			expect( () => compile( consumerPath ) ).not.toThrow();
		}
		expect(
			declarationsForSelector(
				compile( basePath ),
				'.aggregator-status-dashboard *'
			)
		).toEqual( { 'box-sizing': 'border-box' } );
	} );

	it( 'gives every native button the canonical button class', () => {
		const offenders = [];

		for ( const record of jsxClassRecords() ) {
			if ( 'button' !== record.tag ) {
				continue;
			}
			if (
				[ ...record.tokens ].some( ( token ) =>
					CANONICAL_BUTTON_CLASSES.has( token )
				) ||
				hasPrimaryButtonHelper( record.attribute )
			) {
				continue;
			}
			offenders.push(
				`${ path.relative( NODES_SRC, record.file ) }:${
					record.line
				}:${ record.attributeSource || '(missing className)' }`
			);
		}

		expect( offenders ).toEqual( [] );
	} );

	it( 'marks reusable surfaces with their canonical role classes', () => {
		const records = jsxClassRecords();
		const offenders = [];

		for ( const [
			componentClass,
			canonicalClass,
		] of REQUIRED_ROLE_PAIRS ) {
			const matches = records.filter( ( record ) =>
				record.tokens.has( componentClass )
			);
			if ( 0 === matches.length ) {
				offenders.push( `${ componentClass }:missing source markup` );
				continue;
			}
			for ( const record of matches ) {
				if ( ! record.tokens.has( canonicalClass ) ) {
					offenders.push(
						`${ path.relative( NODES_SRC, record.file ) }:${
							record.line
						}:${ componentClass }->${ canonicalClass }`
					);
				}
			}
		}

		const vaultSource = fs.readFileSync(
			path.join( NODES_SRC, 'vault/VaultAdmin.js' ),
			'utf8'
		);
		expect( offenders ).toEqual( [] );
		const logHeaders = records.filter( ( record ) =>
			record.tokens.has( 'newspack-nodes-log-header' )
		);
		expect( logHeaders ).toHaveLength( 1 );
		expect( logHeaders[ 0 ].tokens.has( 'newspack-nodes-table' ) ).toBe(
			false
		);
		expect( vaultSource ).toContain(
			'<table className="newspack-nodes-table">'
		);
		expect( vaultSource ).not.toMatch(
			/className="[^"]*\b(?:wp-list-table|widefat|striped)\b/
		);
	} );

	it( 'keeps structural rail toggles on one neutral role, not stock button paint', () => {
		const records = jsxClassRecords().filter( ( record ) =>
			record.tokens.has( 'newspack-nodes-rail-toggle' )
		);

		expect( records ).toHaveLength( 3 );
		for ( const record of records ) {
			expect( record.tag ).toBe( 'button' );
			expect( record.tokens.has( 'button' ) ).toBe( false );
			expect( record.tokens.has( 'button-small' ) ).toBe( false );
		}
	} );

	it( 'inks the chart Y title, which SVG would otherwise draw black', () => {
		const declarations = mergedDeclarationsForSelectors(
			compile( UI_ENTRY ),
			( selector ) =>
				selector.endsWith( '.newspack-nodes-chart__plot .y-label' )
		);
		expect( declarations?.fill ).toBe( 'var(--ink, var(--np-text))' );
	} );

	it( 'shades selected chart slots in the accent at low opacity', () => {
		const declarations = mergedDeclarationsForSelectors(
			compile( UI_ENTRY ),
			( selector ) =>
				selector.endsWith( '.newspack-nodes-chart__selected' )
		);
		expect( declarations?.fill ).toBe( 'var(--cyan, var(--np-primary))' );
		expect( Number( declarations?.[ 'fill-opacity' ] ) ).toBeLessThan(
			0.3
		);
	} );

	it( 'lays a button out above WordPress own display, once, for everyone', () => {
		// `.wp-core-ui .button` sets `display: inline-block` and is two classes
		// deep, so any single-class component rule laying a button out would
		// silently do nothing — the contents stay one run of inline text. The
		// shared layer wins that once so a component never re-fights it,
		// and specificity is invisible in the rule that needs it, so it is
		// pinned here.
		const sheet = compile( UI_ENTRY );

		let owner = null;
		sheet.walkRules( ( rule ) => {
			if ( ! /\.button\b/.test( rule.selector ) ) {
				return;
			}
			rule.walkDecls( 'display', () => {
				owner = owner ?? rule.selector;
			} );
		} );

		expect( owner ).not.toBeNull();
		// `:where()` contributes nothing, so the count has to come from the
		// classes outside it — and has to clear WordPress's two.
		const classes = owner
			.replace( /:where\([^)]*\)/g, '' )
			.match( /\.[\w-]+/g );
		expect( classes.length ).toBeGreaterThan( 2 );
	} );

	it( 'keeps topology semantic roles free from generic button and badge paint', () => {
		const records = jsxClassRecords();
		const cases = [
			[ 'nodes-tm__expand', [ 'button', 'button-small' ] ],
			[ 'nodes-tm__collapse', [ 'button', 'button-small' ] ],
			[ 'nodes-tm__badge', [ 'newspack-nodes-badge' ] ],
		];
		const offenders = [];

		for ( const [ componentClass, forbiddenClasses ] of cases ) {
			for ( const record of records.filter( ( candidate ) =>
				candidate.tokens.has( componentClass )
			) ) {
				for ( const forbiddenClass of forbiddenClasses ) {
					if ( record.tokens.has( forbiddenClass ) ) {
						offenders.push(
							`${ path.relative( NODES_SRC, record.file ) }:${
								record.line
							}:${ componentClass }->${ forbiddenClass }`
						);
					}
				}
			}
		}

		expect( offenders ).toEqual( [] );
		const pills = records.filter( ( record ) =>
			record.tokens.has( 'is-pill' )
		);
		expect( pills ).toHaveLength( 1 );
		expect( pills[ 0 ].tokens.has( 'nodes-tm__badge' ) ).toBe( true );
	} );

	it( 'keeps inline paint out of Nodes markup', () => {
		const offenders = jsxClassRecords()
			.filter( ( record ) => /\bcolor\s*:/.test( record.styleSource ) )
			.map(
				( record ) =>
					`${ path.relative( NODES_SRC, record.file ) }:${
						record.line
					}:${ record.styleSource }`
			);

		expect( offenders ).toEqual( [] );
	} );

	it( 'keeps semantic text on audited roles outside fixed-dark REPL output', () => {
		const offenders = [];
		const schematicCanvas = path.join(
			NODES_SRC,
			'topology-console/components/SchematicCanvas.js'
		);
		const svgTextClasses = new Set(
			jsxClassRecords()
				.filter(
					( record ) =>
						schematicCanvas === record.file && 'text' === record.tag
				)
				.flatMap( ( record ) => [ ...record.tokens ] )
		);

		for ( const file of sourceFiles() ) {
			compile( file ).walkDecls( ( declaration ) => {
				const selector = declaration.parent.selector || '';
				const renderedTextPaint =
					'color' === declaration.prop ||
					( 'fill' === declaration.prop &&
						[ ...svgTextClasses ].some( ( className ) =>
							selectorHasClass( selector, className )
						) );
				if ( ! renderedTextPaint ) {
					return;
				}
				if ( ! RAW_SEMANTIC_TEXT.test( declaration.value ) ) {
					return;
				}
				const fixedDarkRepl =
					'color' === declaration.prop &&
					GRAPH_VIEW === file &&
					/\.topology-repl__(?:prompt|entry--sent|entry--error)/.test(
						selector
					);
				const reviewedDistinctiveRole =
					/\.topology-repl__(?:toggle|clear)|\.topology-brand__colon|\.topology-subtitle::after|\.newspack-nodes-(?:status|status-badge)/.test(
						selector
					);
				if ( fixedDarkRepl || reviewedDistinctiveRole ) {
					return;
				}
				offenders.push(
					`${ path.relative( NODES_SRC, file ) }:${
						declaration.source.start.line
					}:${ selector }:${ declaration.prop }:${
						declaration.value
					}`
				);
			} );
		}

		expect( [ ...new Set( offenders ) ] ).toEqual( [] );
	} );

	it( 'does not dilute an audited semantic foreground with rule opacity', () => {
		const offenders = [];

		for ( const file of sourceFiles() ) {
			compile( file ).walkRules( ( rule ) => {
				const declarations = Object.fromEntries(
					( rule.nodes || [] )
						.filter( ( node ) => 'decl' === node.type )
						.map( ( node ) => [ node.prop, node.value ] )
				);
				if (
					! /var\(--(?:cyan|brass|sage|oxide)-text/.test(
						declarations.color || ''
					) ||
					! declarations.opacity ||
					1 <= Number( declarations.opacity )
				) {
					return;
				}
				offenders.push(
					`${ path.relative( NODES_SRC, file ) }:${ rule.selector }:${
						declarations.opacity
					}`
				);
			} );
		}

		expect( [ ...new Set( offenders ) ] ).toEqual( [] );
	} );

	it( 'keeps component button classes geometry-only', () => {
		const buttonClasses = new Set();
		for ( const record of jsxClassRecords() ) {
			if ( 'button' !== record.tag ) {
				continue;
			}
			for ( const token of record.tokens ) {
				if ( isComponentClass( token ) ) {
					buttonClasses.add( token );
				}
			}
		}

		const offenders = [];
		for ( const [ file, stylesheet ] of consumerStylesheets() ) {
			stylesheet.walkRules( ( rule ) => {
				const matchedClasses = [ ...buttonClasses ].filter(
					( className ) =>
						rule.selectors.some( ( selector ) =>
							selectorHasClass( selector, className )
						)
				);
				if ( 0 === matchedClasses.length ) {
					return;
				}
				rule.walkDecls( ( declaration ) => {
					const paintsTransition =
						'transition' === declaration.prop &&
						/(?:background|border|box-shadow|color|opacity)/.test(
							declaration.value
						);
					if (
						! isAppearanceProperty( declaration.prop ) &&
						! paintsTransition
					) {
						return;
					}
					offenders.push(
						`${ path.relative( NODES_SRC, file ) }:${
							declaration.source.start.line
						}:${ matchedClasses.join( ',' ) }:${ declaration.prop }`
					);
				} );
			} );
		}

		expect( offenders ).toEqual( [] );
	} );

	it( 'keeps canonical button paint out of consumer stylesheets', () => {
		const offenders = [];

		for ( const [ file, stylesheet ] of consumerStylesheets() ) {
			stylesheet.walkRules( ( rule ) => {
				if (
					! rule.selectors.some( ( selector ) =>
						selectorHasClass( selector, 'button' )
					)
				) {
					return;
				}
				rule.walkDecls( ( declaration ) => {
					const paintsTransition =
						'transition' === declaration.prop &&
						/(?:background|border|box-shadow|color|opacity)/.test(
							declaration.value
						);
					if (
						! isAppearanceProperty( declaration.prop ) &&
						! paintsTransition
					) {
						return;
					}
					offenders.push(
						`${ path.relative( NODES_SRC, file ) }:${
							declaration.source.start.line
						}:${ rule.selector }:${ declaration.prop }`
					);
				} );
			} );
		}

		expect( offenders ).toEqual( [] );
	} );

	it( 'leaves reusable surface paint to canonical role classes', () => {
		const offenders = [];

		for ( const [ file, stylesheet ] of consumerStylesheets() ) {
			stylesheet.walkRules( ( rule ) => {
				for ( const selector of rule.selectors ) {
					if ( ! SURFACE_SELECTORS.has( selector.trim() ) ) {
						continue;
					}
					rule.walkDecls( ( declaration ) => {
						if ( isAppearanceProperty( declaration.prop ) ) {
							offenders.push(
								`${ path.relative( NODES_SRC, file ) }:${
									declaration.source.start.line
								}:${ selector.trim() }:${ declaration.prop }`
							);
						}
					} );
				}
			} );
		}

		expect( offenders ).toEqual( [] );
	} );

	it( 'keeps status-pill structure and worker paint in canonical roles', () => {
		const cases = [
			[
				'event-aggregator/styles/aggregator-status.scss',
				[
					'.aggregator-status-badge',
					'.aggregator-status-badge.small',
					'.aggregator-response-badge',
					'.aggregator-response-badge.small',
				],
			],
			[
				'event-dashboards/styles/worker-status.scss',
				[
					'.worker-status-badge',
					'.worker-status-badge.small',
					'.worker-status-badge.compact',
				],
			],
			[ 'event-dashboards/styles/jobs.scss', [ '.nodes-jobs__status' ] ],
		];
		const offenders = [];

		for ( const [ relativeFile, selectors ] of cases ) {
			const stylesheet = compile( path.join( NODES_SRC, relativeFile ) );
			offenders.push(
				...statusPillOwnershipOffenders(
					stylesheet,
					relativeFile,
					selectors
				)
			);
		}

		expect( offenders ).toEqual( [] );
	} );

	it( 'leaves topology disclosure, provenance, and health paint to canonical roles', () => {
		const stylesheet = compile(
			path.join( NODES_SRC, 'event-dashboards/styles/topology-row.scss' )
		);
		const roleClasses = [
			'nodes-tm__expand',
			'nodes-tm__collapse',
			'nodes-tm__badge',
			'nodes-tm__health',
		];
		const forbiddenProperties =
			/^(?:appearance|background(?:-.+)?|border(?:-.+)?|box-shadow|color|font(?:-.+)?|outline(?:-.+)?|text-transform)$/;
		const offenders = [];

		stylesheet.walkRules( ( rule ) => {
			if (
				! rule.selectors.some( ( selector ) =>
					roleClasses.some( ( className ) =>
						selectorHasClass( selector, className )
					)
				)
			) {
				return;
			}
			rule.walkDecls( ( declaration ) => {
				if ( forbiddenProperties.test( declaration.prop ) ) {
					offenders.push(
						`${ rule.selector }:${ declaration.prop }`
					);
				}
			} );
		} );

		expect( offenders ).toEqual( [] );
		expect(
			mergedDeclarationsForSelectors(
				stylesheet,
				( selector ) =>
					selectorHasClass( selector, 'nodes-tm__expand' ) ||
					selectorHasClass( selector, 'nodes-tm__collapse' )
			)
		).toEqual(
			expect.objectContaining( {
				flex: '0 0 auto',
				'line-height': '1',
				padding: '2px 6px',
			} )
		);
	} );

	it( 'reserves repeated consumer roots for native and stock competitors', () => {
		const repeatedRoot = '.newspack-nodes-ui.newspack-nodes-ui';
		const competitor =
			/(?:^|[\s>+~])(?:button|input|select|textarea)(?=[.#:[\s>+~]|$)|\.button(?=[.#:[\s>+~]|$)|\.components-|\.widefat/;
		const offenders = [];

		for ( const [ file, stylesheet ] of consumerStylesheets() ) {
			stylesheet.walkRules( ( rule ) => {
				for ( const selector of rule.selectors ) {
					if (
						selector.startsWith( repeatedRoot ) &&
						! competitor.test( selector )
					) {
						offenders.push(
							`${ path.relative(
								NODES_SRC,
								file
							) }:${ selector }`
						);
					}
				}
			} );
		}

		expect( offenders ).toEqual( [] );
	} );

	it( 'removes verified zero-consumer appearance selectors', () => {
		const expectedAbsent = [
			[
				path.join(
					NODES_SRC,
					'event-aggregator/styles/aggregator-status.scss'
				),
				[
					'aggregator-status-header',
					'aggregator-server-connection',
					'aggregator-connection-time',
					'aggregator-server-heartbeat',
					'aggregator-heartbeat-row',
					'aggregator-heartbeat-label',
					'aggregator-heartbeat-value',
					'aggregator-heartbeat-status',
					'aggregator-server-error',
					'aggregator-error-message',
					'aggregator-partition-error',
					'rtt-value',
					'rtt-unit',
					'aggregator-partition',
					'aggregator-partitions',
					'aggregator-partition-header',
					'aggregator-partition-stats',
					'aggregator-partition-row',
					'aggregator-partition-stat-label',
					'aggregator-partition-stat-value',
					'aggregator-server-identity',
					'aggregator-server-partition-count',
					'aggregator-readers',
					'aggregator-fleet-stat',
				],
			],
			[
				path.join(
					NODES_SRC,
					'event-dashboards/styles/worker-status.scss'
				),
				[
					'worker-status-full',
					'worker-status',
					'worker-status-loading',
					'worker-status-error',
				],
			],
			[ GRAPH_VIEW, [ 'topology-insp__actions-danger' ] ],
			[
				path.join(
					NODES_SRC,
					'topology-console/styles/topology-console.scss'
				),
				[ 'newspack-nodes-topology-console-page' ],
			],
			[
				path.join( NODES_SRC, 'vault/vault-admin.scss' ),
				[ 'nodes-vault__header' ],
			],
		];
		const offenders = [];

		for ( const [ file, classNames ] of expectedAbsent ) {
			compile( file ).walkRules( ( rule ) => {
				for ( const className of classNames ) {
					if (
						rule.selectors.some( ( selector ) =>
							selectorHasClass( selector, className )
						)
					) {
						offenders.push(
							`${ path.relative(
								NODES_SRC,
								file
							) }:${ className }`
						);
					}
				}
			} );
		}

		const aggregatorStylesheet = compile(
			path.join(
				NODES_SRC,
				'event-aggregator/styles/aggregator-status.scss'
			)
		);
		for ( const selector of [
			'.aggregator-status-refresh-indicator.refreshing',
			'.aggregator-status-refresh-dot.refreshing',
			'.aggregator-status-badge.backoff',
			'.aggregator-status-badge.connection_refused',
			'.aggregator-status-badge.error',
			'.aggregator-status-badge.ssl_error',
			'.aggregator-status-badge.auth_failed',
			'.aggregator-response-badge.slot_expired',
			'.aggregator-response-badge.error',
		] ) {
			aggregatorStylesheet.walkRules( ( rule ) => {
				if ( rule.selectors.includes( selector ) ) {
					offenders.push(
						`event-aggregator/styles/aggregator-status.scss:${ selector }`
					);
				}
			} );
		}

		expect( offenders ).toEqual( [] );
	} );

	it( 'compiles emitting shared partials only through the UI entry', () => {
		const offenders = [];

		for ( const file of sourceFiles() ) {
			if ( UI_ENTRY === file ) {
				continue;
			}
			parse( file ).walkAtRules( ( atRule ) => {
				if ( ! IMPORT_AT_RULES.has( atRule.name ) ) {
					return;
				}
				for ( const target of importTargets( atRule.params ) ) {
					if ( EMITTING_PARTIALS.has( partialName( target ) ) ) {
						offenders.push(
							`${ path.relative( NODES_SRC, file ) }:${
								atRule.source.start.line
							}:@${ atRule.name } ${ target }`
						);
					}
				}
			} );
		}

		expect( offenders ).toEqual( [] );
	} );

	it( 'has no consumer-local focus painter', () => {
		const offenders = [];

		for ( const file of sourceFiles() ) {
			if ( FOCUS_OWNERS.has( file ) ) {
				continue;
			}
			parse( file ).walkDecls( ( declaration ) => {
				if ( ! isFocusProperty( declaration.prop ) ) {
					return;
				}
				let ancestor = declaration.parent;
				while ( ancestor && 'root' !== ancestor.type ) {
					if (
						'rule' === ancestor.type &&
						FOCUS_SELECTOR.test( ancestor.selector )
					) {
						offenders.push(
							`${ path.relative( NODES_SRC, file ) }:${
								declaration.source.start.line
							}:${ declaration.prop }`
						);
						break;
					}
					ancestor = ancestor.parent;
				}
			} );
		}

		expect( offenders ).toEqual( [] );
	} );

	it( 'keeps generic button state roles out of graph artwork', () => {
		const offenders = [];
		const genericButtonState =
			/(?:^|[\s>+~])(?:button)?\.button\.is-(?:active|danger)(?=:|$)/;

		parse( GRAPH_VIEW ).walkRules( ( rule ) => {
			for ( const selector of rule.selector.split( ',' ) ) {
				if ( genericButtonState.test( selector.trim() ) ) {
					offenders.push(
						`${ path.relative( NODES_SRC, GRAPH_VIEW ) }:${
							rule.source.start.line
						}:${ selector.trim() }`
					);
				}
			}
		} );

		expect( offenders ).toEqual( [] );
	} );

	it( 'leaves inherited root typography and ink to the canonical UI asset', () => {
		const topologyApp = declarationsForSelector(
			graphStylesheet,
			'.topology-app'
		);
		for ( const property of [
			'font',
			'font-family',
			'font-size',
			'line-height',
			'color',
			'--nodes-tab-host-fg',
		] ) {
			expect( topologyApp?.[ property ] ).toBeUndefined();
		}
	} );

	it( 'keeps reviewed portal geometry independent of a topology root', () => {
		const graphSource = parse( GRAPH_VIEW );
		const selectors = [];
		graphSource.walkRules( ( rule ) => {
			selectors.push( rule.selector.trim() );
		} );

		for ( const selector of [
			':is(.topology-app, .topology-modal) .button.is-compact',
			'.topology-edit-row__input',
			'.topology-modal > .newspack-nodes-modal__header',
			'.topology-modal__input',
		] ) {
			expect( selectors ).toContain( selector );
		}

		for ( const legacySelector of [
			'.topology-app .button.is-compact',
			'.topology-app .topology-edit-row__input',
			'.topology-app .topology-modal__input',
		] ) {
			expect( selectors ).not.toContain( legacySelector );
		}
		expect(
			selectors.filter( ( selector ) =>
				/\.topology-modal__(?:header|title|close)\b/.test( selector )
			)
		).toEqual( [] );
	} );

	it( 'keeps portaled inspector compact-button geometry inside topology surfaces', () => {
		const inlineGeometry = {
			width: 'auto',
			'text-align': 'center',
		};
		for ( const selector of [
			':is(.topology-app, .topology-modal) .nodes-profiler__toolbar .button.is-compact',
			':is(.topology-app, .topology-modal) .timeline-view__filters .button.is-compact',
		] ) {
			expect(
				declarationsForSelector( inspectorViewsStylesheet, selector )
			).toEqual( inlineGeometry );
		}

		// Every Triage command — a row's or the footer's — reads inline.
		expect(
			declarationsForSelector(
				triageViewStylesheet,
				':is(.topology-app, .topology-modal) .triage-view .button.is-compact'
			)
		).toEqual( inlineGeometry );
		expect(
			declarationsForSelector(
				triageViewStylesheet,
				':is(.topology-app, .topology-modal) .triage-view__grid .button.is-compact + .button.is-compact'
			)
		).toEqual( { 'margin-left': '6px' } );
	} );

	it( 'keeps canonical appearance out of portal geometry rules', () => {
		const graphSource = parse( GRAPH_VIEW );
		const forbidden = {
			':is(.topology-app, .topology-modal) .button.is-compact': [
				'background',
				'border',
				'border-radius',
				'box-shadow',
				'color',
				'font-family',
				'font-weight',
				'letter-spacing',
				'text-transform',
			],
			'.topology-edit-row__input': [
				'background',
				'border',
				'box-shadow',
				'color',
				'font-family',
			],
			'.topology-modal > .newspack-nodes-modal__header': [
				'background',
				'border',
				'border-bottom',
				'color',
				'display',
				'font-size',
			],
			'.topology-modal__input': [
				'background',
				'border',
				'border-radius',
				'box-shadow',
				'color',
			],
		};
		const offenders = [];

		graphSource.walkRules( ( rule ) => {
			const properties = forbidden[ rule.selector.trim() ];
			if ( ! properties ) {
				return;
			}
			rule.walkDecls( ( declaration ) => {
				if ( properties.includes( declaration.prop ) ) {
					offenders.push(
						`${ rule.selector.trim() }:${ declaration.prop }`
					);
				}
			} );
		} );

		expect( offenders ).toEqual( [] );
	} );

	it( 'keeps inspector telemetry paint in canonical semantic roles', () => {
		for ( const selector of [
			'.topology-insp__type',
			'.topology-insp__spark-val',
			'.topology-field-row__val--num',
			'.topology-insp__level--error',
			'.topology-insp__level--warn',
			'.topology-insp__level--debug',
		] ) {
			const declarations =
				declarationsForSelector( graphStylesheet, selector ) || {};
			expect( declarations.color ).toBeUndefined();
			expect( declarations.opacity ).toBeUndefined();
		}
	} );

	it( 'leaves native option and select appearance to canonical controls', () => {
		const offenders = [];
		parse( GRAPH_VIEW ).walkRules( ( rule ) => {
			for ( const selector of rule.selector.split( ',' ) ) {
				const normalized = selector.trim();
				if (
					normalized.includes( 'select option' ) ||
					normalized.includes( 'select.topology-edit-row__input' )
				) {
					offenders.push( normalized );
				}
			}
		} );

		expect( offenders ).toEqual( [] );
	} );

	it( 'leaves graph action danger paint to the canonical button role', () => {
		const generic = [];
		const specialized = [];

		graphStylesheet.walkRules( ( rule ) => {
			for ( const selector of rule.selector.split( ',' ) ) {
				const normalized = selector.trim();
				if (
					/(?:^|[\s>+~])(?:button)?\.button\.is-(?:active|danger)(?=:|$)/.test(
						normalized
					)
				) {
					generic.push( normalized );
				}
				if (
					'.topology-edit-delete' === normalized ||
					normalized.endsWith( ' .topology-edit-delete' )
				) {
					rule.walkDecls( ( declaration ) => {
						if ( isAppearanceProperty( declaration.prop ) ) {
							specialized.push( declaration.prop );
						}
					} );
				}
			}
		} );

		expect( generic ).toEqual( [] );
		expect( specialized ).toEqual( [] );
	} );

	it( 'preserves compact empty-state geometry after canonical adoption', () => {
		const cases = [
			[
				'station/station.scss',
				'nodes-station__empty',
				{ padding: '0' },
			],
			[
				'event-aggregator/styles/aggregator-status.scss',
				'aggregator-status-empty',
				{ padding: '48px 24px', 'text-align': 'center' },
			],
			[
				'event-dashboards/styles/probe-tab.scss',
				'nodes-probe-tab__empty',
				{ padding: '24px', 'text-align': 'center' },
			],
			[
				'event-dashboards/styles/config-audit.scss',
				'nodes-config-audit__empty',
				{ padding: '24px', 'text-align': 'center' },
			],
			[
				'shared/components/LogBrowser.scss',
				'newspack-nodes-log-browser__empty',
				{ padding: '12px 10px', 'text-align': 'left' },
			],
			[
				'shared/components/LogRowList.scss',
				'newspack-nodes-log-rows__empty',
				{
					height: '100%',
					'min-height': '60px',
					padding: '0',
				},
			],
			[
				'topology-console/styles/graph-view.scss',
				'topology-insp__empty',
				{ padding: '100px 20px' },
			],
			[
				'topology-console/styles/graph-view.scss',
				'topology-tt__empty',
				{ padding: '4px', 'text-align': 'left' },
			],
			[
				'topology-console/styles/graph-view.scss',
				'topology-edit-empty',
				{ padding: '4px', 'text-align': 'left' },
			],
			[
				'topology-console/components/triage-view.scss',
				'triage-view__empty',
				{ padding: '12px', 'text-align': 'left' },
			],
			[
				'topology-console/components/timeline-view.scss',
				'timeline-view__empty',
				{ padding: '12px', 'text-align': 'left' },
			],
		];

		for ( const [ relativeFile, className, expected ] of cases ) {
			const stylesheet = compile( path.join( NODES_SRC, relativeFile ) );
			const selector = `.newspack-nodes-empty-state.${ className }`;
			expect( declarationsForSelector( stylesheet, selector ) ).toEqual(
				expect.objectContaining( expected )
			);
			const beforeDeclarations = [
				'newspack-nodes-log-browser__empty',
				'newspack-nodes-log-rows__empty',
			].includes( className )
				? mergedDeclarationsForSelectors(
						compile( UI_ENTRY ),
						( candidate ) =>
							candidate.includes(
								'.newspack-nodes-empty-state.is-quiet::before'
							)
				  )
				: declarationsForSelector(
						stylesheet,
						`${ selector }::before`
				  );
			expect( beforeDeclarations ).toEqual( { display: 'none' } );
		}
	} );

	it( 'preserves compact loading and runtime-table geometry', () => {
		const tabHostStylesheet = compile(
			path.join( NODES_SRC, 'station/station.scss' )
		);
		// The tab pane insets the placeholder, so it pads nothing itself.
		expect(
			declarationsForSelector(
				tabHostStylesheet,
				'.newspack-nodes-performance-loading.nodes-station__lazy-loading'
			)
		).toEqual( {
			display: 'block',
			'min-height': '0',
		} );
		expect(
			declarationsForSelector(
				graphStylesheet,
				'.newspack-nodes-performance-loading.topology-edit-empty'
			)
		).toEqual(
			expect.objectContaining( {
				display: 'block',
				'min-height': '0',
				padding: '4px 0',
			} )
		);

		const runtimeSelector = '.newspack-nodes-table.nodes-runtime__grid';
		const runtimeGrid = declarationsForSelector(
			inspectorViewsStylesheet,
			runtimeSelector
		);
		expect( runtimeGrid ).toEqual(
			expect.objectContaining( {
				'font-size': 'inherit',
				'line-height': 'inherit',
				color: 'var(--ink)',
			} )
		);
		// The cells take their face from the shared terminal-data role.
		expect( runtimeGrid ).not.toHaveProperty( 'font-family' );
		expect(
			declarationsForSelector(
				graphStylesheet,
				'.topology-insp__section:has(> .nodes-runtime__grid)'
			)
		).toEqual( {
			'font-size': 'var(--np-text-2xs)',
			'overflow-x': 'auto',
		} );
		expect(
			declarationsForSelector(
				graphStylesheet,
				'.topology-insp__section > .nodes-runtime__grid + .nodes-runtime__grid'
			)
		).toEqual( { 'margin-top': '9px' } );
		for ( const cellClass of [
			'nodes-runtime__th',
			'nodes-runtime__td',
		] ) {
			expect(
				declarationsForSelector(
					inspectorViewsStylesheet,
					`${ runtimeSelector } .${ cellClass }`
				)
			).toEqual( expect.objectContaining( { padding: '3px 8px' } ) );
		}
	} );

	it( 'keeps semantic tab geometry in the canonical UI asset', () => {
		expect(
			mergedDeclarationsForSelectors(
				compile( UI_ENTRY ),
				( selector ) =>
					selectorHasClass( selector, 'nodes-tab-host__tab' ) &&
					! selector.includes( ':hover' ) &&
					! selector.includes( '.is-active' )
			)
		).toEqual(
			expect.objectContaining( {
				padding: '6px 14px',
				'font-size': '13px',
			} )
		);
	} );

	it( 'neutralizes WordPress desktop and mobile geometry on migrated raw controls', () => {
		const cases = [
			[
				'event-dashboards/styles/summary-cards.scss',
				'nodes-ctl__toggle',
				{
					'min-height': '0',
					width: '34px',
					height: '19px',
					padding: '0',
					'line-height': '1',
					'margin-bottom': '0',
					'vertical-align': 'baseline',
				},
			],
		];

		for ( const [ relativeFile, className, expected ] of cases ) {
			expect(
				declarationsForRepeatedButtonClass(
					compile( path.join( NODES_SRC, relativeFile ) ),
					className
				)
			).toEqual( expect.objectContaining( expected ) );
		}

		const logRowListStylesheet = compile(
			path.join( NODES_SRC, 'shared/components/LogRowList.scss' )
		);
		// @longform The list compensates scrollTop itself when new rows arrive
		// above a reader scrolled into history. Browser scroll anchoring does
		// the SAME correction for the growing spacer, and the two stack: every
		// new row would move the reader by two, so the page slides up. jsdom
		// lacks anchoring, so behavioural tests cannot catch this —
		// the declaration is the only guard.
		expect(
			declarationsForSelector(
				logRowListStylesheet,
				'.newspack-nodes-log-rows'
			)
		).toEqual( expect.objectContaining( { 'overflow-anchor': 'none' } ) );
		expect(
			declarationsForSelector(
				logRowListStylesheet,
				'.newspack-nodes-rail-toggle'
			)
		).toEqual(
			expect.objectContaining( {
				position: 'absolute',
				width: '18px',
				height: '18px',
				display: 'flex',
				'align-items': 'center',
				'justify-content': 'center',
				padding: '0',
			} )
		);
		expect(
			declarationsForRepeatedButtonClass(
				logRowListStylesheet,
				'newspack-nodes-rail-toggle'
			)
		).toBeUndefined();

		expect(
			declarationsForSelector(
				graphStylesheet,
				':is(.topology-app, .topology-modal) .button.is-compact'
			)
		).toEqual(
			expect.objectContaining( {
				'min-height': '0',
				height: 'auto',
				padding: '8px 10px',
				'font-size': 'var(--np-text-2xs)',
				'line-height': '1.2',
				'margin-bottom': '0',
				'vertical-align': 'baseline',
			} )
		);

		const graphButtonHeights = [
			[ 'topology-canvas__layout-chip', 'auto' ],
			[ 'topology-edit-row__reset', 'auto' ],
			[ 'topology-hull-panel__open', 'auto' ],
			[ 'topology-edit-command__remove', '20px' ],
			[ 'topology-field-row__nav', 'auto' ],
			[ 'topology-edit-chip__clear', 'auto' ],
			[ 'topology-edit-delete', 'auto' ],
			[ 'topology-edit-command__add', 'auto' ],
			[ 'topology-insp__listener-x', 'auto' ],
			[ 'topology-tt__transport-btn', 'auto' ],
		];
		for ( const [ className, height ] of graphButtonHeights ) {
			expect(
				declarationsForRepeatedButtonClass( graphStylesheet, className )
			).toEqual(
				expect.objectContaining( {
					'min-height': '0',
					height,
					'margin-bottom': '0',
					'vertical-align': 'baseline',
				} )
			);
		}

		for ( const className of [
			'topology-inspector__toggle',
			'topology-palette__toggle',
		] ) {
			expect(
				mergedDeclarationsForSelectors( graphStylesheet, ( selector ) =>
					selectorHasClass( selector, className )
				)
			).toEqual(
				expect.objectContaining( {
					width: '18px',
					height: '18px',
					display: 'flex',
					'align-items': 'center',
					'justify-content': 'center',
					padding: '0',
				} )
			);
			expect(
				declarationsForRepeatedButtonClass( graphStylesheet, className )
			).toBeUndefined();
		}

		const consoleStylesheet = compile(
			path.join(
				NODES_SRC,
				'topology-console/styles/topology-console.scss'
			)
		);
		for ( const [ stylesheet, className ] of [
			[ graphStylesheet, 'topology-open-item' ],
			[ consoleStylesheet, 'topology-settings-panel__close' ],
		] ) {
			expect(
				declarationsForRepeatedButtonClass( stylesheet, className )
			).toEqual(
				expect.objectContaining( {
					'min-height': '0',
					height: 'auto',
					'margin-bottom': '0',
					'vertical-align': 'baseline',
				} )
			);
		}
		expect(
			mergedDeclarationsForSelectors(
				consoleStylesheet,
				( selector ) =>
					selector.startsWith(
						'.newspack-nodes-ui.newspack-nodes-ui'
					) &&
					selector.includes( '.topology-settings-var-row .button' )
			)
		).toEqual(
			expect.objectContaining( {
				'min-height': '0',
				height: 'auto',
				'margin-bottom': '0',
				'vertical-align': 'baseline',
			} )
		);
	} );

	it( 'preserves prior Nodes card boxes without local border ownership', () => {
		const cases = [
			[ 'shared/blocks/stats.scss', '.nodes-card', '11px 15px' ],
			[ 'shared/blocks/time-chart.scss', '.nodes-topics', '9px 11px' ],
			[
				'event-dashboards/styles/topology-row.scss',
				'.nodes-tm__topology',
				'1px',
			],
			[
				'event-aggregator/styles/aggregator-status.scss',
				'.aggregator-server-card',
				'12px 15px 12px 17px',
			],
			[
				'topology-console/styles/topology-console.scss',
				'.topology-settings-panel',
				'13px 15px',
			],
		];

		for ( const [ relativeFile, selector, padding ] of cases ) {
			const declarations = mergedDeclarationsForSelectors(
				compile( path.join( NODES_SRC, relativeFile ) ),
				( candidate ) => candidate === selector
			);
			expect( declarations ).toEqual(
				expect.objectContaining( { padding } )
			);
			expect( declarations.border ).toBeUndefined();
			expect( declarations[ 'border-color' ] ).toBeUndefined();
		}
	} );

	it( 'lays Aggregator cards out at one height, timings in a fixed grid', () => {
		const stylesheet = compile(
			path.join(
				NODES_SRC,
				'event-aggregator/styles/aggregator-status.scss'
			)
		);
		const labelRules = [];
		stylesheet.walkRules( ( rule ) => {
			if (
				rule.selectors.some( ( selector ) =>
					selectorHasClass( selector, 'newspack-nodes-stat-label' )
				)
			) {
				labelRules.push( rule.selector );
			}
		} );

		expect(
			declarationsForSelector( stylesheet, '.aggregator-status-servers' )
		).toEqual(
			expect.objectContaining( {
				display: 'grid',
				'grid-auto-rows': '1fr',
			} )
		);
		expect(
			declarationsForSelector( stylesheet, '.aggregator-status-servers' )[
				'align-items'
			]
		).toBeUndefined();
		expect(
			declarationsForSelector(
				stylesheet,
				'.aggregator-fleet-probe-button'
			)
		).toEqual( { 'margin-top': 'auto', 'align-self': 'flex-end' } );
		expect(
			declarationsForSelector( stylesheet, '.aggregator-partition-line' )
		).toEqual(
			expect.objectContaining( {
				display: 'grid',
				'grid-template-columns': 'repeat(3, minmax(0, 1fr))',
				'font-size': 'var(--np-text-2xs)',
			} )
		);
		expect( labelRules ).toEqual( [] );
		expect(
			declarationsForSelector( stylesheet, '.aggregator-stat-value' )
		).toEqual(
			expect.objectContaining( {
				'font-family': 'var(--np-font-mono)',
				height: '18px',
				overflow: 'hidden',
				'text-overflow': 'ellipsis',
				'white-space': 'nowrap',
			} )
		);
	} );

	it( 'lets the header controls span, so a widening readout moves nothing', () => {
		// Spanning the row and packing to the end keeps the cluster's left edge
		// still as a count widens, and leaves slack for a host — the Gyroscope's
		// category legend — to claim with `margin-right: auto`.
		expect(
			declarationsForSelector(
				graphStylesheet,
				'.topology-header__controls'
			)
		).toEqual(
			expect.objectContaining( {
				flex: '1 1 auto',
				'min-width': '0',
				'justify-content': 'flex-end',
			} )
		);
	} );

	it( 'shrinks the header subtitle before the controls give up width', () => {
		// Flex shrinks in proportion to shrink × basis, so the subtitle needs a
		// factor that dwarfs the controls' 1 × their content width, or the
		// end-packed controls overflow leftward over a hostname with width left.
		const subtitle = declarationsForSelector(
			graphStylesheet,
			'.topology-subtitle'
		);
		expect( Number( subtitle[ 'flex-shrink' ] ) ).toBeGreaterThanOrEqual(
			1000
		);
		expect( subtitle ).toEqual(
			expect.objectContaining( {
				'min-width': '0',
				'text-overflow': 'ellipsis',
			} )
		);
	} );

	it( 'gives the shared header ONE resting height, owned by the header', () => {
		// Every host mounts the same header — station, console, debug overlay and
		// a consumer's standalone dashboard — so the header sets the height, not
		// a declaration each host repeats and one of them gets wrong.
		expect(
			declarationsForSelector( graphStylesheet, '.topology-header' )
		).toEqual( expect.objectContaining( { 'min-height': '64px' } ) );

		for ( const sheet of [
			'station/station.scss',
			'debug-overlay/debug-overlay.scss',
		] ) {
			const source = fs.readFileSync(
				path.join( NODES_SRC, sheet ),
				'utf8'
			);
			expect( source ).not.toMatch( /\.topology-header\s*\{/ );
		}
	} );

	it( 'pins fixed control, row, and modal dimensions', () => {
		const debugStylesheet = compile(
			path.join( NODES_SRC, 'debug-overlay/debug-overlay.scss' )
		);
		expect(
			declarationsForSelector( debugStylesheet, '.nodes-debug__fab' )
		).toEqual(
			expect.objectContaining( {
				position: 'fixed',
				right: '24px',
				bottom: '24px',
				width: '48px',
				height: '48px',
			} )
		);
		const logBrowserStylesheet = compile(
			path.join( NODES_SRC, 'shared/components/LogBrowser.scss' )
		);
		expect(
			declarationsForSelector(
				logBrowserStylesheet,
				'.newspack-nodes-log-browser__mode'
			)
		).toEqual(
			expect.objectContaining( {
				'box-sizing': 'border-box',
				'line-height': '2.92307692',
				'min-height': '40px',
				padding: '0 16px',
				'white-space': 'nowrap',
			} )
		);
		expect(
			declarationsForSelector( debugStylesheet, '.nodes-debug__panel' )
				.padding
		).toBeUndefined();

		const summaryStylesheet = compile(
			path.join( NODES_SRC, 'event-dashboards/styles/summary-cards.scss' )
		);
		expect(
			declarationsForSelector( summaryStylesheet, '.nodes-ctl__toggle' )
		).toEqual(
			expect.objectContaining( {
				width: '34px',
				height: '19px',
				position: 'relative',
				padding: '0',
			} )
		);

		const logStylesheet = compile(
			path.join( NODES_SRC, 'shared/components/LogRowList.scss' )
		);
		expect(
			declarationsForSelector( logStylesheet, '.newspack-nodes-log-row' )
		).toEqual(
			expect.objectContaining( {
				height: 'var(--log-row-height, 33px)',
				padding: '0 12px',
			} )
		);

		// ModalShell copies this floor into MODAL_MIN_W to decide whether a
		// debug-overlay panel can contain a dialog at all. Let the two drift
		// and the gate permits an anchor the geometry cannot honour.
		const modalMinW = numericConstant(
			path.join( NODES_SRC, 'topology-console/components/Modal.js' ),
			'MODAL_MIN_W'
		);
		expect(
			declarationsForSelector( graphStylesheet, '.topology-modal' )
		).toEqual(
			expect.objectContaining( {
				'min-width': `${ modalMinW }px`,
				'max-width': 'min(560px, var(--nodes-modal-max-w, 100%))',
			} )
		);
		expect(
			declarationsForSelector(
				graphStylesheet,
				'.topology-modal > .newspack-nodes-modal__header'
			)
		).toEqual( { padding: '8px 8px 8px 16px' } );

		// @longform ModalShell's MODAL_HEADER_H is the console header's height:
		// the taller of the shared title line and close, the console's own
		// vertical padding and the shared header rule. Let the stylesheets move
		// and the anchor gate admits a panel the dialog cannot fit inside.
		const sharedModal = compile(
			path.join( NODES_SRC, 'shared/styles/_modal.scss' )
		);
		const inShared = ( role ) =>
			declarationsForSelector(
				sharedModal,
				`:where(.newspack-nodes-ui) .newspack-nodes-modal .newspack-nodes-modal__${ role }`
			);
		const px = ( value ) => {
			expect( value ).toMatch( /^\d+px$/ );
			return Number.parseInt( value, 10 );
		};
		const themeToken = ( name ) =>
			fs
				.readFileSync(
					path.join( NODES_SRC, 'theme/newspack-theme.scss' ),
					'utf8'
				)
				.match( new RegExp( `${ name }:\\s*([^;]+);` ) )[ 1 ];
		const lineHeight = inShared( 'title' )[ 'line-height' ];
		expect( lineHeight ).toBe( 'var(--np-lh-m)' );
		const [ padTop, , padBottom ] = declarationsForSelector(
			graphStylesheet,
			'.topology-modal > .newspack-nodes-modal__header'
		).padding.split( ' ' );
		expect(
			numericConstant(
				path.join( NODES_SRC, 'topology-console/components/Modal.js' ),
				'MODAL_HEADER_H'
			)
		).toBe(
			Math.max(
				px( themeToken( '--np-lh-m' ) ),
				px( inShared( 'close' ).height )
			) +
				px( padTop ) +
				px( padBottom ) +
				px( inShared( 'header' )[ 'border-bottom' ].split( ' ' )[ 0 ] )
		);

		const modalStylesheet = compile(
			path.join( NODES_SRC, 'shared/components/Modal.scss' )
		);
		expect(
			declarationsForSelector(
				modalStylesheet,
				'.newspack-nodes-modal__backdrop > .newspack-nodes-modal'
			)
		).toEqual(
			expect.objectContaining( {
				width: '90%',
				'max-width': '640px',
				'max-height': '90vh',
				padding: 'var(--np-space-lg)',
			} )
		);
		expect(
			declarationsForSelector(
				modalStylesheet,
				'.newspack-nodes-modal__backdrop > .newspack-nodes-modal > .newspack-nodes-modal__header'
			)
		).toEqual( {
			'margin-bottom': 'var(--np-space-md)',
			'padding-bottom': 'var(--np-space-md)',
		} );
		expect(
			declarationsForSelector(
				modalStylesheet,
				'.newspack-nodes-modal__backdrop > .newspack-nodes-modal h4'
			)
		).toBeUndefined();

		const alertStylesheet = compile(
			path.join( NODES_SRC, 'event-dashboards/styles/topology-row.scss' )
		);
		const alertChromeRules = [];
		alertStylesheet.walkRules( ( rule ) => {
			if (
				rule.selectors.some( ( selector ) =>
					/\.nodes-tm__alert(?:-title\b|-actions\b|\b.*\.newspack-nodes-modal__header)/.test(
						selector
					)
				)
			) {
				alertChromeRules.push( rule.selector );
			}
		} );
		expect( alertChromeRules ).toEqual( [] );
	} );

	// One column: side by side, a long "Open <name>.tsl" overflows its half.
	// minmax(0, …) and a wrapping label, or a no-wrap label still pushes the
	// column past the panel: WordPress's `.button` is `white-space: nowrap`.
	it( 'stacks the hull panel actions in one full-width column', () => {
		expect(
			declarationsForSelector(
				graphStylesheet,
				'.topology-hull-panel__actions'
			)
		).toEqual(
			expect.objectContaining( {
				display: 'grid',
				'grid-template-columns': 'minmax(0, 1fr)',
				gap: '8px',
			} )
		);
		const wraps = [];
		graphStylesheet.walkRules( ( rule ) => {
			if (
				rule.selector.includes( '.topology-hull-panel__open' ) &&
				rule.selector.includes( '.newspack-nodes-ui.newspack-nodes-ui' )
			) {
				rule.walkDecls( 'white-space', ( d ) => wraps.push( d.value ) );
			}
		} );
		expect( wraps ).toEqual( [ 'normal' ] );
		expect(
			declarationsForSelector(
				graphStylesheet,
				'.topology-hull-panel__open'
			)
		).not.toHaveProperty( 'width' );

		// Both halves need the same WordPress-geometry neutralization, or the
		// pair renders at two different heights.
		const neutralizedProps = ( className ) => {
			const props = new Set();
			graphStylesheet.walkRules( ( rule ) => {
				if ( ! rule.selector.includes( className ) ) {
					return;
				}
				rule.walkDecls( ( decl ) => props.add( decl.prop ) );
			} );
			return props;
		};
		for ( const prop of [ 'min-height', 'line-height' ] ) {
			expect(
				neutralizedProps( '.topology-hull-panel__remove' )
			).toContain( prop );
		}
	} );

	// Clearing a value restores a default; it destroys nothing. Only the glyphs
	// that remove something carry the danger role, as a red circle.
	it( 'reserves the danger role for controls that destroy something', () => {
		const CLEARS = [
			'topology-edit-row__reset',
			'topology-edit-chip__clear',
			'topology-settings-panel__close',
		];
		const DESTROYS = [
			'topology-edit-command__remove',
			'topology-insp__listener-x',
		];
		const seen = new Set();

		for ( const record of jsxClassRecords() ) {
			for ( const className of CLEARS ) {
				if ( ! record.tokens.has( className ) ) {
					continue;
				}
				seen.add( className );
				expect( [ className, [ ...record.tokens ] ] ).toEqual( [
					className,
					expect.arrayContaining( [ 'is-plain' ] ),
				] );
				expect( record.tokens.has( 'button-link-delete' ) ).toBe(
					false
				);
			}
			for ( const className of DESTROYS ) {
				if ( ! record.tokens.has( className ) ) {
					continue;
				}
				seen.add( className );
				expect( [ className, [ ...record.tokens ] ] ).toEqual( [
					className,
					expect.arrayContaining( [
						'button-link-delete',
						'is-circle',
					] ),
				] );
			}
		}

		expect( [ ...seen ].sort() ).toEqual(
			[ ...CLEARS, ...DESTROYS ].sort()
		);
	} );

	// The dashboards inherited their box model from wp-admin's html/inherit
	// chain; when that stopped reaching a card, min-width became a content
	// width and every card grew by its padding.
	it( 'owns its own box model rather than inheriting the host page', () => {
		expect(
			declarationsForSelector(
				compile( UI_ENTRY ),
				'.newspack-nodes-ui.newspack-nodes-ui *'
			)
		).toEqual( expect.objectContaining( { 'box-sizing': 'border-box' } ) );
	} );

	// @longform The page ring is an ELEMENT mounted at body level while the
	// picker is armed, not a pseudo-element toggled by `:hover`: an outline on
	// the page box is painted over by its own children, and a viewport-sized
	// box appearing and vanishing under the pointer is its own bug.
	it( 'rings the page box with a mounted overlay', () => {
		const ring = declarationsForSelector(
			compile( UI_ENTRY ),
			'.newspack-nodes-ask-ring'
		);

		expect( ring.position ).toBe( 'fixed' );
		expect( ring[ 'pointer-events' ] ).toBe( 'none' );
		expect( ring.outline ).toBe(
			declarationsForSelector(
				compile( UI_ENTRY ),
				':where(html).newspack-nodes-asking [data-ask]:not([data-ask-page]):hover'
			).outline
		);
	} );

	// @longform A pick stands until the selection ends, so its mark persists
	// where the hover ring comes and goes, and it fills as well as rings. Each
	// paint is `!important`, because zebra stripes repaint a row's `background`
	// and the focus reset clears the clicked pick's outline and shadow, each
	// above the mark's specificity. A non-row pick rings with an outline, which
	// paints above the target's own children.
	it( 'tints every pick and rings a non-row pick above its children', () => {
		const ui = compile( UI_ENTRY );
		const tint = declarationsWithImportance( ui, PICK );
		const ring = declarationsWithImportance(
			ui,
			`${ PICK }:not(tr, .newspack-nodes-table__row, g)`
		);

		expect( tint[ 'background-image' ] ).toEqual( {
			value: expect.stringMatching( /^linear-gradient\(/ ),
			important: true,
		} );
		expect( ring.outline ).toEqual( {
			value: declarationsForSelector(
				ui,
				':where(html).newspack-nodes-asking [data-ask]:not([data-ask-page]):hover'
			).outline,
			important: true,
		} );
	} );

	// @longform A picked row rings by its four edges, so a run of picks reads
	// as one block rather than as rings with a doubled bar between them: each
	// row drops the edge it shares with a picked neighbour. A table row paints
	// on its cells, and only the outer cells keep a side edge.
	it( 'rings a picked row by edges that adjacent picks merge', () => {
		const ui = compile( UI_ENTRY );
		const rows = ':is(tr, .newspack-nodes-table__row)';
		const { 'box-shadow': shadow } = declarationsWithImportance(
			ui,
			`${ PICK }.newspack-nodes-table__row`
		);

		expect( shadow.important ).toBe( true );
		for ( const edge of [ 'top', 'bottom', 'left', 'right' ] ) {
			expect( shadow.value ).toContain( `var(--ask-edge-${ edge },` );
		}
		expect(
			declarationsForSelector( ui, `${ PICK }:is(tr) > td` )[
				'box-shadow'
			]
		).toBe( shadow.value );
		expect(
			declarationsForSelector(
				ui,
				`${ PICK }:is(tr) > td:not(:first-child)`
			)
		).toEqual( { '--ask-edge-left': '0' } );
		expect(
			declarationsForSelector(
				ui,
				`${ PICK }:is(tr) > td:not(:last-child)`
			)
		).toEqual( { '--ask-edge-right': '0' } );
		expect(
			declarationsForSelector(
				ui,
				`${ PICK }${ rows } + [data-ask-picked]`
			)
		).toEqual( { '--ask-edge-top': '0' } );
		expect(
			declarationsForSelector(
				ui,
				`${ PICK }${ rows }:has(+ [data-ask-picked])`
			)
		).toEqual( { '--ask-edge-bottom': '0' } );
	} );

	// An SVG group has no box to ring, so a picked flame frame
	// rings by its rect's stroke, over the chart's own frame stroke.
	it( 'strokes a picked SVG frame', () => {
		const stroke = declarationsWithImportance(
			compile( UI_ENTRY ),
			`${ PICK }:is(g) > rect`
		);

		expect( stroke.stroke ).toEqual( {
			value: 'var(--np-accent, #003da5)',
			important: true,
		} );
		expect( stroke[ 'stroke-width' ] ).toEqual( {
			value: '2px',
			important: true,
		} );
	} );

	// @longform The page box is the one target that cannot wear the mark: its
	// tint shows behind every child, so the whole dashboard reads as picked.
	// A picked page shows on the ring that already stands for it, as a band
	// inside the ring's own line.
	it( 'shows a picked page on its ring, not as a tint over the page', () => {
		const ui = compile( UI_ENTRY );
		let unscoped = false;
		ui.walkRules( ( rule ) => {
			if (
				rule.selectors.some(
					( sel ) =>
						sel.includes( '[data-ask-picked]' ) &&
						! sel.includes( 'ask-ring' ) &&
						! sel.includes( ':not([data-ask-page])' )
				)
			) {
				unscoped = true;
			}
		} );
		const ring = declarationsForSelector(
			ui,
			'.newspack-nodes-ask-ring[data-ask-picked]'
		);

		expect( unscoped ).toBe( false );
		expect( ring?.[ 'box-shadow' ] ).toMatch( /^inset / );
	} );

	// @longform Scoped to our own UI, which is all that is ever askable: the
	// shell wears these classes and every portal carries them out to the body.
	// Forcing a cursor onto the whole admin document reached WordPress's
	// chrome too, which is never a target.
	it( 'arms the ? cursor over our own UI, not the whole admin page', () => {
		const ui = compile( UI_ENTRY );

		expect(
			declarationsForSelector(
				ui,
				':where(html).newspack-nodes-asking :where(.newspack-nodes-ui)'
			)?.cursor
		).toBe( 'help' );
		let universal = false;
		ui.walkRules( ( rule ) => {
			if (
				rule.selectors.some( ( sel ) => sel.endsWith( 'asking *' ) )
			) {
				universal = true;
			}
		} );
		expect( universal ).toBe( false );
	} );

	// @longform A dark dashboard gets a light scrollbar until the element says
	// otherwise: `color-scheme` is what the UA reads for a scrollbar as much as
	// for a control, so it belongs on the skin root, where every scroller
	// inside inherits it rather than each one naming itself.
	it( 'declares the dark colour scheme on every dark skin root', () => {
		const ui = compile( UI_ENTRY );
		const declared = new Set();
		ui.walkRules( ( rule ) => {
			const roots = rule.selectors.filter( ( selector ) =>
				selector.endsWith( '.newspack-nodes-ui.newspack-nodes-ui' )
			);
			if (
				! roots.length ||
				! rule.nodes.some(
					( node ) =>
						'decl' === node.type &&
						'color-scheme' === node.prop &&
						'dark' === node.value
				)
			) {
				return;
			}
			for ( const selector of roots ) {
				const skin = selector.match( /^\.theme-([a-z0-9-]+)/ );
				if ( skin ) {
					declared.add( skin[ 1 ] );
				}
			}
		} );

		expect( [ ...declared ].sort() ).toEqual( darkSkins().sort() );
	} );

	// @longform The ring draws at body level, so its layer ranks against what
	// else lives there rather than against the chrome inside a shell: above a
	// shell's own 99, under the dialog stack a brief opens in.
	it( 'ranks the page ring above a shell and below the dialogs', () => {
		const ring = declarationsForSelector(
			compile( UI_ENTRY ),
			'.newspack-nodes-ask-ring'
		);

		expect( Number( ring[ 'z-index' ] ) ).toBeGreaterThan( 99 );
		expect( Number( ring[ 'z-index' ] ) ).toBeLessThan(
			layerToken( 'layer-modal' )
		);
	} );

	// On the page a table is a content surface like a card; a card lifts it.
	it( 'seats a table on the same surface as a card, outside one', () => {
		const ui = compile( UI_ENTRY );
		expect(
			declarationsForSelector(
				ui,
				':where(.newspack-nodes-ui) .newspack-nodes-table'
			).background
		).toBe(
			`var(--nodes-table-surface, ${
				declarationsForSelector(
					ui,
					':where(.newspack-nodes-ui) .newspack-nodes-card'
				).background
			})`
		);
	} );

	// Both table paths stripe with one formula, and a row is never painted
	// the table's own surface — that renders as no stripe at all.
	it( 'stripes plain tables and ARIA grids identically', () => {
		const ui = compile( UI_ENTRY );
		const base = declarationsForSelector(
			ui,
			':where(.newspack-nodes-ui) .newspack-nodes-table'
		).background;
		const stripes = [];
		ui.walkRules( ( rule ) => {
			if (
				! rule.selector.includes( '.newspack-nodes-table' ) ||
				// The undivided variant deliberately cancels the stripe.
				rule.selector.includes( '--undivided' )
			) {
				return;
			}
			if ( ! /nth-child|row-odd|row-even/.test( rule.selector ) ) {
				return;
			}
			rule.walkDecls( 'background', ( decl ) =>
				stripes.push( decl.value )
			);
		} );

		// A row may restate the table's own surface (the contrast audits resolve
		// a background per row state); what must not vary is the stripe itself.
		const tinted = [ ...new Set( stripes ) ].filter(
			( value ) => value !== base
		);
		expect( tinted ).toHaveLength( 1 );
	} );

	it( 'draws a destructive glyph as a circle', () => {
		expect(
			declarationsForSelector(
				compile( UI_ENTRY ),
				'.newspack-nodes-ui.newspack-nodes-ui .button.is-circle'
			)
		).toEqual(
			expect.objectContaining( {
				'border-radius': '50%',
				'aspect-ratio': '1',
			} )
		);
	} );

	// outline + box-shadow paint OUTSIDE the border box, so a clipping ancestor
	// erases the focus ring on every button in the group.
	it( 'does not clip the focus ring off the header mode buttons', () => {
		expect(
			declarationsForSelector( graphStylesheet, '.topology-mode' )
		).not.toHaveProperty( 'overflow' );
	} );

	// A long topology list must scroll inside the dialog, and the dialog must
	// clear the page header rather than sit under it.
	it( 'caps the modal below the header and scrolls its body', () => {
		expect(
			parseInt(
				declarationsForSelector(
					graphStylesheet,
					'.topology-modal-backdrop'
				).padding,
				10
			)
		).toBeGreaterThan( 0 );
		expect(
			declarationsForSelector( graphStylesheet, '.topology-modal' )
		).toEqual(
			expect.objectContaining( {
				'max-height': 'min(100%, var(--nodes-modal-max-h, 100%))',
				display: 'flex',
				'flex-direction': 'column',
			} )
		);
		expect(
			declarationsForSelector( graphStylesheet, '.topology-modal__body' )
		).toEqual(
			// Both axes, explicitly: `overflow-y: auto` alone computes x to
			// auto too, which is the horizontal scrollbar under the input.
			expect.objectContaining( {
				overflow: 'hidden auto',
				'min-height': '0',
			} )
		);
	} );

	// Proximity has to group a heading with the section BELOW it, so the space
	// above must beat the space below (padding-bottom + the first item's pad).
	// The gap lives on the section wrapper: every heading is the first child of
	// its own wrapper, so a `:first-child` margin on the heading zeroes them all.
	it( 'sets a palette section heading apart from the group above it', () => {
		const group = declarationsForSelector(
			graphStylesheet,
			'.topology-palette__group'
		);
		const below =
			parseInt( group[ 'padding-bottom' ], 10 ) +
			parseInt(
				declarationsForSelector(
					graphStylesheet,
					'.topology-palette__item'
				).padding.split( /\s+/ )[ 0 ],
				10
			);
		const gap = parseInt(
			declarationsForSelector(
				graphStylesheet,
				'.topology-palette__section + .topology-palette__section'
			)[ 'margin-top' ],
			10
		);

		expect( gap ).toBeGreaterThan( below );
		expect(
			declarationsForSelector(
				graphStylesheet,
				'.topology-palette__group:first-child'
			)
		).toBeUndefined();
	} );
} );

/**
 * The shared field rule styles every bare input with padding and a border. It
 * has to say `box-sizing` too, or `width: 100%` renders 22px wider than its
 * container — and a container with `overflow-y: auto` (per spec `overflow-x`
 * then computes to `auto` as well) grows a horizontal scrollbar across its
 * whole width, as the Save-topology modal would.
 *
 * `_buttons.scss` sets it beside its own border and padding, and so must the
 * field rule.
 */
describe( 'shared field chrome', () => {
	const uiStylesheet = postcss.parse( sass.compile( UI_ENTRY ).css, {
		from: UI_ENTRY,
	} );

	it( 'frames a stock token field or combobox once: the frame wears the field, its input none', () => {
		let fieldRule = null;
		uiStylesheet.walkRules( ( rule ) => {
			if (
				null === fieldRule &&
				rule.selector.includes( 'input:not([type=checkbox])' )
			) {
				fieldRule = rule;
			}
		} );
		expect( fieldRule.selector ).toContain(
			':not(.components-form-token-field__input)'
		);
		const frame = mergedDeclarationsForSelectors(
			uiStylesheet,
			( selector ) =>
				selectorHasClass(
					selector,
					'components-combobox-control__suggestions-container'
				)
		);
		expect( frame?.border ).toBe( '1px solid var(--np-field-border)' );
		const entry = mergedDeclarationsForSelectors(
			uiStylesheet,
			( selector ) =>
				selectorHasClass(
					selector,
					'components-form-token-field__input'
				)
		);
		expect( entry?.border ).toBe( '0' );
	} );

	it( 'ships the DataViews skin once, in the UI entry, not in a component sheet', () => {
		const component = path.join(
			NODES_SRC,
			'shared/components/DataViewsList.js'
		);
		expect( fs.readFileSync( component, 'utf8' ) ).not.toMatch(
			/import\s+['"][^'"]+\.scss['"]/
		);
		expect(
			fs.existsSync(
				path.join( NODES_SRC, 'shared/components/DataViewsList.scss' )
			)
		).toBe( false );
		const wrapper = mergedDeclarationsForSelectors(
			uiStylesheet,
			( selector ) =>
				':where(.newspack-nodes-ui) .newspack-nodes-dataviews > .dataviews-wrapper' ===
				selector
		);
		expect( wrapper?.gap ).toBe( '12px' );
	} );

	it( 'draws DataViews table header menus as header text, not outlined buttons', () => {
		const sheet = uiStylesheet;
		const header = mergedDeclarationsForSelectors( sheet, ( selector ) =>
			selectorHasClass( selector, 'dataviews-view-table-header-button' )
		);
		expect( header?.[ '--button-secondary-background' ] ).toBe(
			'transparent'
		);
		expect( header?.[ '--button-secondary-border' ] ).toBe( 'transparent' );
	} );

	it( 'draws DataViews title links and table row rules in the skin', () => {
		const sheet = uiStylesheet;
		const link = mergedDeclarationsForSelectors(
			sheet,
			( selector ) =>
				selectorHasClass( selector, 'dataviews-title-field' ) &&
				/ a$/.test( selector )
		);
		expect( link?.color ).toBe( 'var(--ink, var(--np-text))' );
		const row = mergedDeclarationsForSelectors( sheet, ( selector ) =>
			/\.dataviews-view-table tr$/.test( selector )
		);
		expect( row?.[ 'border-top-color' ] ).toBe(
			'var(--paper-shadow, var(--np-border-strong))'
		);
	} );

	it( 'draws DataViews filter chips, the bulk count and list row rules in the skin', () => {
		const sheet = uiStylesheet;
		const of = ( test ) => mergedDeclarationsForSelectors( sheet, test );
		expect(
			of(
				( selector ) =>
					/summary-chip$/.test( selector ) &&
					selectorHasClass( selector, 'newspack-nodes-ui' )
			)?.background
		).toBe( 'var(--paper, var(--np-surface))' );
		expect(
			of( ( selector ) => /summary-chip:hover/.test( selector ) )
				?.background
		).toBe( 'var(--hover, var(--np-surface-muted))' );
		expect(
			of( ( selector ) =>
				selectorHasClass(
					selector,
					'dataviews-bulk-actions-footer__item-count'
				)
			)?.color
		).toBe( 'var(--ink-3, var(--np-text-secondary))' );
		expect(
			of( ( selector ) =>
				/\.dataviews-view-list div\[role=row\]$/.test( selector )
			)?.[ 'border-top-color' ]
		).toBe( 'var(--paper-shadow, var(--np-border-strong))' );
	} );

	it( 'draws a stock toggle and a disabled primary button in the skin', () => {
		const track = mergedDeclarationsForSelectors(
			uiStylesheet,
			( selector ) =>
				selectorHasClass( selector, 'components-form-toggle__track' )
		);
		expect( track?.[ 'background-color' ] ).toBe(
			'var(--paper-2, var(--np-surface-subtle))'
		);
		let disabled = null;
		uiStylesheet.walkRules( ( rule ) => {
			if (
				rule.selectors.some(
					( selector ) =>
						selectorHasClass( selector, 'button-primary' ) &&
						selector.includes( ':disabled' )
				)
			) {
				rule.walkDecls( 'background', ( decl ) => {
					disabled = decl;
				} );
			}
		} );
		expect( disabled?.important ).toBe( true );
	} );

	it( 'draws a link button inside a DataViews title field in the skin ink', () => {
		const link = mergedDeclarationsForSelectors(
			uiStylesheet,
			( selector ) =>
				selectorHasClass( selector, 'dataviews-title-field' ) &&
				selectorHasClass( selector, 'is-link' )
		);
		expect( link?.color ).toBe( 'var(--ink, var(--np-text))' );
	} );

	it( 'hides a run-only list row\u2019s actions past the stock rule that shows them', () => {
		const sheet = uiStylesheet;
		// Stock shows it at (0,3,1): `.dataviews-view-list div[role=row] …`.
		const hide = mergedDeclarationsForSelectors( sheet, ( selector ) =>
			/\.newspack-nodes-dataviews__run-only\.dataviews-view-list div\[role=row\] \.dataviews-view-list__item-actions$/.test(
				selector
			)
		);
		expect( hide?.display ).toBe( 'none' );
	} );

	it( 'spaces a DataViewsList\u2019s header rows, list and pager apart', () => {
		const sheet = uiStylesheet;
		const wrapper = mergedDeclarationsForSelectors( sheet, ( selector ) =>
			/\.newspack-nodes-dataviews > \.dataviews-wrapper$/.test( selector )
		);
		expect( wrapper?.gap ).toBe( '12px' );
	} );

	it( 'draws the DataViews filter popover in the skin', () => {
		const sheet = uiStylesheet;
		const of = ( test ) => mergedDeclarationsForSelectors( sheet, test );
		expect(
			of( ( selector ) => /combobox-list$/.test( selector ) )?.[
				'border-top-color'
			]
		).toBe( 'var(--paper-shadow, var(--np-border-strong))' );
		expect(
			of( ( selector ) => /combobox__input$/.test( selector ) )?.[
				'background-color'
			]
		).toBe( 'var(--paper, var(--np-surface))' );
		expect(
			of( ( selector ) => /combobox__wrapper svg$/.test( selector ) )
				?.fill
		).toBe( 'currentcolor' );
		expect(
			of( ( selector ) => /listitem-multi-selection$/.test( selector ) )
				?.background
		).toBe( 'var(--paper, var(--np-surface))' );
		expect(
			of( ( selector ) => /listitem:hover$/.test( selector ) )?.background
		).toBe( 'var(--hover, var(--np-surface-muted))' );

		let fieldRule = null;
		uiStylesheet.walkRules( ( rule ) => {
			if (
				null === fieldRule &&
				rule.selector.includes( 'input:not([type=checkbox])' )
			) {
				fieldRule = rule;
			}
		} );
		expect( fieldRule.selector ).toContain(
			':not(.dataviews-filters__search-widget-filter-combobox__input)'
		);
	} );

	it( 'keeps a hovered or selected DataViews list row in the skin\u2019s ink', () => {
		const sheet = uiStylesheet;
		const of = ( test ) => mergedDeclarationsForSelectors( sheet, test );
		const hover = of( ( selector ) =>
			/div\[role=row\]:not\(\.is-selected\):hover$/.test( selector )
		);
		expect( hover?.color ).toBe( 'var(--ink, var(--np-text))' );
		expect( hover?.[ 'background-color' ] ).toBe(
			'var(--hover, var(--np-surface-muted))'
		);
		expect(
			of( ( selector ) =>
				/:hover \.dataviews-title-field$/.test( selector )
			)?.color
		).toBe( 'var(--ink, var(--np-text))' );
		expect(
			of( ( selector ) =>
				/\.is-selected \.dataviews-view-list__item-wrapper$/.test(
					selector
				)
			)?.color
		).toBe( 'var(--ink, var(--np-text))' );
		expect(
			of( ( selector ) =>
				/div\[role=row\]\.is-selected\.is-selected$/.test( selector )
			)?.[ 'border-top-color' ]
		).toBe( 'var(--paper-shadow, var(--np-border-strong))' );
	} );

	it( 'lets a DataViewsList row\u2019s focus rings show past its title cell', () => {
		const sheet = uiStylesheet;
		for ( const cell of [
			'dataviews-view-list__title-field',
			'dataviews-view-activity__item-title',
			'dataviews-view-grid__title-field',
		] ) {
			const declared = mergedDeclarationsForSelectors(
				sheet,
				( selector ) => selector.endsWith( `.${ cell }` )
			);
			expect( declared?.overflow ).toBe( 'visible' );
		}
	} );

	it( 'gives bare fields border-box, so width:100% cannot overflow', () => {
		let fieldRule = null;
		uiStylesheet.walkRules( ( rule ) => {
			if (
				null === fieldRule &&
				// Sass strips the attribute quotes in the compiled selector.
				rule.selector.includes( 'input:not([type=checkbox])' )
			) {
				fieldRule = rule;
			}
		} );
		expect( fieldRule ).not.toBeNull();

		const declared = [];
		fieldRule.walkDecls( ( decl ) => declared.push( decl.prop ) );
		// It sets padding + border; box-sizing is what makes those safe.
		expect( declared ).toContain( 'padding' );
		expect( declared ).toContain( 'border' );
		expect( declared ).toContain( 'box-sizing' );
	} );

	// The shared rule owns it. A per-component redeclaration is dead weight
	// that also lies: it credits the component for a fix that lives upstream,
	// and the next reader chasing a modal-width bug believes the wrong cause.
	// Measured live: the body's content box is 390px, the input fills it at
	// width:100%, and WP admin's own `margin: 1px` on inputs makes its MARGIN
	// box 392 — exactly the 2px the body offers to scroll. Zeroing the inline
	// margin takes the overflow to 0; clipping the axis only hides it.
	it( 'zeroes the modal input inline margin so width:100% fits', () => {
		const declared = declarationsForSelector(
			graphStylesheet,
			'.topology-modal__input'
		);
		expect( declared ).not.toBeNull();
		expect( declared[ 'margin-inline' ] ).toBe( '0' );
	} );

	it( 'leaves the modal input to inherit that, not redeclare it', () => {
		const declared = declarationsForSelector(
			graphStylesheet,
			'.topology-modal__input'
		);
		expect( declared ).not.toBeNull();
		expect( declared[ 'box-sizing' ] ).toBeUndefined();
	} );
} );

describe( 'one page edge', () => {
	const ui = postcss.parse( sass.compile( UI_ENTRY ).css, {
		from: UI_ENTRY,
	} );
	const tabHost = compile(
		path.join( NODES_SRC, 'shared/tabs/TabHost.scss' )
	);
	// The left edge of a `padding` shorthand of one to four values, in pixels.
	const leftEdge = ( padding ) => {
		const parts = padding
			.split( /\s+/ )
			.map( ( part ) => parseFloat( part ) );
		return [ parts[ 0 ], parts[ 1 ], parts[ 1 ], parts[ 3 ] ][
			parts.length - 1
		];
	};

	it( 'insets page content by one shared role', () => {
		expect(
			declarationsForSelector(
				ui,
				':where(.newspack-nodes-ui) .newspack-nodes-page-inset'
			)
		).toEqual( { padding: '16px 20px' } );
	} );

	it( 'starts the header text, the first tab label and the content on one edge', () => {
		const header = declarationsForSelector(
			graphStylesheet,
			'.topology-header'
		);
		const bar = declarationsForSelector(
			tabHost,
			'.nodes-tab-host__tabbar'
		);
		const tab = mergedDeclarationsForSelectors( ui, ( selector ) =>
			/ \.nodes-tab-host__tab$/.test( selector )
		);
		const inset = declarationsForSelector(
			ui,
			':where(.newspack-nodes-ui) .newspack-nodes-page-inset'
		);
		const edge = leftEdge( inset.padding );
		expect( edge ).toBe( 20 );
		expect( leftEdge( header.padding ) ).toBe( edge );
		expect( leftEdge( bar.padding ) + leftEdge( tab.padding ) ).toBe(
			edge
		);
	} );

	it.each( [
		[ 'event-dashboards/styles/overview.scss', '.nodes-overview' ],
		[ 'event-dashboards/styles/probe-tab.scss', '.nodes-probe-tab' ],
		[ 'event-dashboards/styles/config-audit.scss', '.nodes-config-audit' ],
		[
			'event-dashboards/styles/log-viewer.scss',
			'.newspack-nodes-log-viewer',
		],
		[ 'sessions/sessions-admin.scss', '.nodes-sessions' ],
		[ 'vault/vault-admin.scss', '.event-aggregator-servers-admin' ],
		[
			'event-aggregator/styles/aggregator-status.scss',
			'.aggregator-status-dashboard',
		],
	] )(
		'leaves the inset and the page paint to the tab pane in %s',
		( file, selector ) => {
			const declared =
				declarationsForSelector(
					compile( path.join( NODES_SRC, file ) ),
					selector
				) ?? {};
			for ( const prop of [ 'padding', 'min-height', 'background' ] ) {
				expect( [ prop, declared[ prop ] ] ).toEqual( [
					prop,
					undefined,
				] );
			}
		}
	);
} );

describe( 'audited appearance', () => {
	const sheet = ( file ) => compile( path.join( NODES_SRC, file ) );
	const workerStatus = sheet( 'event-dashboards/styles/worker-status.scss' );
	const aggregator = sheet(
		'event-aggregator/styles/aggregator-status.scss'
	);
	const theme = sheet( 'theme/newspack-theme.scss' );
	const selectorsOf = ( stylesheet ) => {
		const found = [];
		stylesheet.walkRules( ( rule ) => found.push( ...rule.selectors ) );
		return found;
	};

	it( 'keeps no select rule the header controls never sit under', () => {
		expect(
			selectorsOf( graphStylesheet ).filter( ( selector ) =>
				selectorHasClass( selector, 'topology-select' )
			)
		).toEqual( [] );
	} );

	it( 'leaves an edit-row field its radius from the shared field rule', () => {
		const radii = [];
		graphStylesheet.walkRules( ( rule ) => {
			if (
				rule.selectors.some( ( selector ) =>
					selectorHasClass( selector, 'topology-edit-row__input' )
				)
			) {
				rule.walkDecls( 'border-radius', ( decl ) =>
					radii.push( decl.value )
				);
			}
		} );
		expect( radii ).toEqual( [] );
	} );

	it( 'paints nothing on a topology-row root no markup wears', () => {
		expect(
			selectorsOf(
				sheet( 'event-dashboards/styles/topology-row.scss' )
			).filter( ( selector ) => '.nodes-tm' === selector )
		).toEqual( [] );
	} );

	it( 'dims the page behind every dialog with one skin scrim', () => {
		expect(
			declarationsForSelector(
				sheet( 'shared/components/Modal.scss' ),
				'.newspack-nodes-modal__backdrop'
			).background
		).toBe( 'var(--scrim)' );
		expect(
			declarationsForSelector(
				graphStylesheet,
				'.topology-modal-backdrop'
			).background
		).toBe( 'var(--scrim)' );
		const scrims = [];
		theme.walkDecls( '--scrim', ( decl ) => scrims.push( decl.value ) );
		expect( scrims ).toEqual( [ 'rgba(8, 10, 14, 0.62)' ] );
	} );

	it( 'draws the per-skin canvas washes and shapes from skin tokens', () => {
		const literals = [];
		graphStylesheet.walkRules( ( rule ) => {
			// CRT's scanlines are the shared mixin's, not a skin's wash.
			if (
				! rule.selectors.some(
					( selector ) =>
						selectorHasClass( selector, 'topology-canvas' ) &&
						! selector.includes( 'theme-crt' )
				)
			) {
				return;
			}
			rule.walkDecls( ( decl ) => {
				if ( /#[0-9a-f]{3,8}\b|rgba?\(/i.test( decl.value ) ) {
					literals.push( `${ rule.selector } ${ decl.prop }` );
				}
			} );
		} );
		expect( literals ).toEqual( [] );
		expect(
			declarationsForSelector( graphStylesheet, '.topology-canvas' )
				.background
		).toBe( 'var(--canvas-wash)' );
	} );

	it( 'rounds and lifts a log partition row off its card, its track a recess', () => {
		expect(
			declarationsForSelector( workerStatus, '.log-partition-row' )
		).toMatchObject( {
			background: 'var(--paper)',
			'border-radius': 'var(--np-radius-sm)',
		} );
		expect(
			declarationsForSelector( workerStatus, '.segment-bar-h' ).background
		).toBe( 'var(--paper-3)' );
		expect(
			declarationsForSelector( workerStatus, '.segment-fill-h.processed' )
				.background
		).toBe( 'color-mix(in srgb, var(--sage) 40%, var(--paper-3))' );
	} );

	it( 'leaves every aggregator badge tone to the shared status badge', () => {
		const painted = [];
		aggregator.walkRules( ( rule ) => {
			if (
				! rule.selectors.some(
					( selector ) =>
						selectorHasClass(
							selector,
							'aggregator-status-badge'
						) ||
						selectorHasClass(
							selector,
							'aggregator-response-badge'
						)
				)
			) {
				return;
			}
			rule.walkDecls( ( decl ) => {
				if (
					[ 'background', 'color' ].includes( decl.prop ) &&
					! rule.selector.includes( '::before' )
				) {
					painted.push( `${ rule.selector } ${ decl.prop }` );
				}
			} );
		} );
		expect( painted ).toEqual( [] );
	} );

	it( 'sets the overlay message list in the skin mono face and status tokens', () => {
		const overview = sheet( 'debug-overlay/tabs/overview-tab.scss' );
		expect(
			declarationsForSelector(
				overview,
				'.nodes-debug__panel .nodes-overview__messages ul'
			)[ 'font-family' ]
		).toBe( 'var(--font-mono)' );
		expect(
			declarationsForSelector(
				overview,
				'.nodes-debug__panel .nodes-overview__messages .nodes-overview__msg--warning'
			)[ 'border-left-color' ]
		).toBe( 'var(--brass, var(--np-warning))' );
		expect(
			declarationsForSelector(
				overview,
				'.nodes-debug__panel .nodes-overview__messages .nodes-overview__msg--error'
			)[ 'border-left-color' ]
		).toBe( 'var(--oxide, var(--np-error))' );
	} );

	it( 'seats palette and title-block chrome lighter than the surface under it', () => {
		expect(
			selectorsOf( graphStylesheet ).filter( ( selector ) =>
				/__item:hover \.topology-palette__glyph$/.test( selector )
			)
		).toEqual( [] );
		expect(
			declarationsForSelector(
				graphStylesheet,
				'.topology-palette__footer'
			).background
		).toBe( 'var(--paper-2)' );
		// The canvas is --paper in eight skins and --paper-3 in the rest, so
		// only --paper, framed, never sits below it; its cells take no fill.
		expect(
			declarationsForSelector( graphStylesheet, '.topology-title-block' )
				.background
		).toBe( 'var(--paper)' );
		expect(
			declarationsForSelector(
				graphStylesheet,
				'.topology-title-block__k'
			).background
		).toBeUndefined();
	} );
} );

describe( "the skins' web fonts", () => {
	const imports = ( stylesheet ) => {
		const found = [];
		stylesheet.walkAtRules( 'import', ( rule ) =>
			found.push( rule.params )
		);
		return found;
	};

	// The fonts are a style handle of their own, `Admin::FONTS_HANDLE`.
	it( 'ride no shared sheet, so a page loads them only by asking', () => {
		for ( const sheet of [
			compile( path.join( NODES_SRC, 'theme/newspack-theme.scss' ) ),
			compile( UI_ENTRY ),
			graphStylesheet,
		] ) {
			expect( imports( sheet ) ).toEqual( [] );
		}
	} );
} );

describe( 'the error colours', () => {
	// `_tokens.scss` spells each once: `$error-bg` and `$error-text`.
	it( 'are spelled once, in the tokens, never inline with a fallback', () => {
		const offenders = walkScss( NODES_SRC )
			.filter( ( file ) => ! file.endsWith( '_tokens.scss' ) )
			.flatMap( ( file ) =>
				fs
					.readFileSync( file, 'utf8' )
					.split( '\n' )
					.map( ( line, index ) => [ line, index + 1 ] )
					.filter( ( [ line ] ) =>
						/var\(\s*--oxide(?:-text)?\s*,/.test( line )
					)
					.map(
						( [ , line ] ) =>
							`${ path.relative( NODES_SRC, file ) }:${ line }`
					)
			);
		expect( offenders ).toEqual( [] );
		const tokens = scss.parse(
			fs.readFileSync(
				path.join( NODES_SRC, 'shared/styles/_tokens.scss' ),
				'utf8'
			)
		);
		const spelled = {};
		tokens.walkDecls( /^\$error-(bg|text)$/, ( decl ) => {
			spelled[ decl.prop ] = decl.value;
		} );
		expect( spelled ).toEqual( {
			'$error-bg': 'var(--oxide, var(--np-error))',
			'$error-text': 'var(--oxide-text, var(--np-error-text))',
		} );
	} );
} );

describe( 'the product error ink', () => {
	// A text ink, as the skins' `--*-text` inks are, never a status fill.
	it( 'paints text where a refused label falls back to it', () => {
		expect( RAW_SEMANTIC_TEXT.test( 'var(--np-error-text)' ) ).toBe(
			false
		);
		expect( RAW_SEMANTIC_TEXT.test( 'var(--np-error)' ) ).toBe( true );
	} );
} );

describe( 'the title block', () => {
	const of = ( selector ) =>
		declarationsForSelector( graphStylesheet, selector );

	// Its keys are translated, so the key column takes its longest label and
	// the values the rest of a cartouche between 312px and 432px wide.
	it( 'sizes the key column to its longest key, one column for every row', () => {
		expect( of( '.topology-title-block' ) ).toMatchObject( {
			display: 'grid',
			'grid-template-columns': 'max-content minmax(0, 1fr)',
			'min-width': '312px',
			'max-width': '432px',
		} );
		expect( of( '.topology-title-block__row' ) ).toMatchObject( {
			display: 'grid',
			'grid-column': '1/-1',
			'grid-template-columns': 'subgrid',
		} );
	} );

	// A long sheet name ends in an ellipsis inside the frame.
	it( 'clips a value to its column with an ellipsis', () => {
		expect( of( '.topology-title-block__v' ) ).toMatchObject( {
			'min-width': '0',
			overflow: 'hidden',
			'text-overflow': 'ellipsis',
			'white-space': 'nowrap',
		} );
	} );
} );

describe( 'shared log-row inks', () => {
	const ui = postcss.parse( sass.compile( UI_ENTRY ).css, {
		from: UI_ENTRY,
	} );
	const of = ( selector ) => declarationsForSelector( ui, selector );

	it.each( [
		[ 'fast', 'var(--sage-text, var(--np-text))' ],
		[ 'slow', 'var(--brass-text, var(--np-text))' ],
		[ 'critical', 'var(--oxide-text, var(--np-error-text))' ],
	] )( 'inks a %s duration once, for every log pane', ( speed, color ) => {
		expect(
			of( `:where(.newspack-nodes-ui) .entry-duration--${ speed }` )
		).toEqual( { color } );
	} );

	it.each( [
		[
			'error',
			{
				color: 'var(--oxide-text, var(--np-error-text))',
				'font-weight': '600',
			},
		],
		[
			'warning',
			{
				color: 'var(--brass-text, var(--np-text))',
				'font-weight': '600',
			},
		],
		[
			'stderr',
			{
				color: 'var(--ink-3, var(--np-text-secondary))',
				'font-style': 'italic',
			},
		],
		[ 'info', { color: 'var(--ink-3, var(--np-text-secondary))' } ],
	] )( 'inks a %s keyword by its data-keyword', ( keyword, declared ) => {
		expect(
			of(
				`:where(.newspack-nodes-ui) .entry-keyword[data-keyword=${ keyword }]`
			)
		).toEqual( declared );
	} );
} );

describe( 'status badge type', () => {
	const ui = postcss.parse( sass.compile( UI_ENTRY ).css, {
		from: UI_ENTRY,
	} );

	it( 'sizes the badge itself at the 2xs step', () => {
		expect(
			declarationsForSelector(
				ui,
				':where(.newspack-nodes-ui) .newspack-nodes-status-badge'
			)[ 'font-size' ]
		).toBe( 'var(--np-text-2xs)' );
	} );

	it.each( [ '', '.small', '.compact', '.is-pill' ] )(
		'sets the badge%s on the product type scale, no smaller than its 2xs step',
		( variant ) => {
			const declared = mergedDeclarationsForSelectors(
				ui,
				( selector ) =>
					`:where(.newspack-nodes-ui) .newspack-nodes-status-badge${ variant }` ===
					selector
			);
			expect( declared ).toBeDefined();
			expect( [ undefined, 'var(--np-text-2xs)' ] ).toContain(
				declared[ 'font-size' ]
			);
		}
	);

	it( 'sets a small round-trip reading no smaller than the 2xs step', () => {
		expect(
			declarationsForSelector(
				compile(
					path.join(
						NODES_SRC,
						'event-aggregator/styles/aggregator-status.scss'
					)
				),
				'.aggregator-rtt.small'
			)[ 'font-size' ]
		).toBe( 'var(--np-text-2xs)' );
	} );

	it( 'leaves the jobs status tone to the shared badge', () => {
		const jobs = compile(
			path.join( NODES_SRC, 'event-dashboards/styles/jobs.scss' )
		);
		const painted = [];
		jobs.walkRules( ( rule ) => {
			if (
				rule.selectors.some( ( selector ) =>
					selectorHasClass( selector, 'nodes-jobs__status' )
				)
			) {
				rule.walkDecls( ( decl ) => painted.push( decl.prop ) );
			}
		} );
		expect( painted ).toEqual( [] );
	} );
} );

describe( 'status badge elevation', () => {
	const ui = postcss.parse( sass.compile( UI_ENTRY ).css, {
		from: UI_ENTRY,
	} );
	const tone = ( state ) =>
		declarationsForSelector(
			ui,
			`:where(.newspack-nodes-ui) .newspack-nodes-status-badge.${ state }`
		);

	it.each( [ 'is-neutral', 'held', 'idle' ] )(
		'lifts a %s badge to the lightest rung, framed, never darker than its card',
		( state ) => {
			expect( tone( state ) ).toMatchObject( {
				background: 'var(--paper, var(--np-surface))',
				'box-shadow':
					'inset 0 0 0 1px var(--paper-shadow, var(--np-border-strong))',
			} );
		}
	);

	it( 'fills no tone from a surface rung below the lightest', () => {
		const sunk = [];
		ui.walkRules( ( rule ) => {
			if (
				rule.selectors.some( ( selector ) =>
					selectorHasClass( selector, 'newspack-nodes-status-badge' )
				)
			) {
				rule.walkDecls( /^background/, ( decl ) => {
					if ( /--paper-[23]\b/.test( decl.value ) ) {
						sunk.push( `${ rule.selector } ${ decl.value }` );
					}
				} );
			}
		} );
		expect( sunk ).toEqual( [] );
	} );
} );

describe( 'a table steps up a rung inside a card or modal', () => {
	const ui = postcss.parse( sass.compile( UI_ENTRY ).css, {
		from: UI_ENTRY,
	} );
	const SURFACE =
		'var(--nodes-table-surface, var(--paper-2, var(--np-surface-subtle)))';
	const tableRules = () => {
		const found = [];
		ui.walkRules( ( rule ) => {
			if (
				rule.selectors.some( ( selector ) =>
					/\.newspack-nodes-table(?:__(?:header|row|details|summary))?(?![\w-])/.test(
						selector
					)
				)
			) {
				found.push( rule );
			}
		} );
		return found;
	};

	it.each( [
		'.newspack-nodes-card',
		'.newspack-nodes-card--elevated',
		'.newspack-nodes-modal',
		'.newspack-nodes-modal__header',
		'.components-modal__header',
		'.components-card',
		'.components-surface',
		'.components-panel',
		'.components-popover__content',
		'.nodes-tab-host__tabbar',
		'.topology-header',
	] )( 'lifts every table inside %s to the lightest rung', ( container ) => {
		const declared = mergedDeclarationsForSelectors( ui, ( selector ) =>
			new RegExp(
				`${ container.replace( /[.]/g, '\\.' ) }(?![\\w-])`
			).test( selector )
		);
		expect( declared?.[ '--nodes-table-surface' ] ).toBe(
			'var(--paper, var(--np-surface))'
		);
	} );

	it( 'fills every --paper-2 surface through the one mixin that lifts a table', () => {
		const PAPER_2 = 'var(--paper-2, var(--np-surface-subtle))';
		const unpaired = [];
		ui.walkRules( ( rule ) => {
			const props = {};
			rule.walkDecls( ( decl ) => ( props[ decl.prop ] = decl.value ) );
			const fills = Object.values( props ).includes( PAPER_2 );
			if (
				fills !==
				( undefined !== props[ '--nodes-table-surface' ] )
			) {
				unpaired.push( rule.selector.replace( /\s+/g, ' ' ) );
			}
		} );
		expect( unpaired ).toEqual( [] );
		const sources = walkScss( path.join( NODES_SRC, 'shared/styles' ) )
			.map( ( file ) => fs.readFileSync( file, 'utf8' ) )
			.join( '\n' );
		// An undivided table reads the variable too, and falls back to transparent.
		expect(
			sources.match(
				/var\(\s*--nodes-table-surface,\s*var\(\s*--paper-2/g
			)
		).toHaveLength( 1 );
		expect( sources.match( /--nodes-table-surface:/g ) ).toHaveLength( 1 );
	} );

	it( 'paints table, header, rows, stripes and hover from the one surface', () => {
		const literal = [];
		let reads = 0;
		for ( const rule of tableRules() ) {
			rule.walkDecls( /^background/, ( decl ) => {
				if ( decl.value.includes( SURFACE ) ) {
					reads += 1;
				} else if ( /--paper-2\b/.test( decl.value ) ) {
					literal.push( `${ rule.selector } ${ decl.value }` );
				}
			} );
		}
		expect( literal ).toEqual( [] );
		expect( reads ).toBeGreaterThanOrEqual( 9 );
	} );

	it( 'paints no table part --paper-2 except through the table surface', () => {
		const tablePart =
			/(?:^|[\s>+~])(?:table|thead|tbody|tr|th)(?![\w-])|table__|[\w-]*table(?![\w-])/;
		const literal = [];
		for ( const [ file, stylesheet ] of [
			[ UI_ENTRY, ui ],
			...consumerStylesheets(),
		] ) {
			stylesheet.walkRules( ( rule ) => {
				if (
					! rule.selectors.some( ( sel ) => tablePart.test( sel ) )
				) {
					return;
				}
				rule.walkDecls( /^background/, ( decl ) => {
					if (
						/--paper-2\b/.test( decl.value ) &&
						! decl.value.includes( '--nodes-table-surface' )
					) {
						literal.push(
							`${ path.relative( NODES_SRC, file ) }:${
								rule.selector
							}`
						);
					}
				} );
			} );
		}
		expect( literal ).toEqual( [] );
	} );

	it( 'gives an undivided table the stepped surface where one is set', () => {
		expect(
			declarationsForSelector(
				ui,
				':where(.newspack-nodes-ui) .newspack-nodes-table--undivided'
			).background
		).toBe( 'var(--nodes-table-surface, transparent)' );
	} );
} );

describe( 'settings-table headings', () => {
	it( 'inks a form-table row heading as its label, over WordPress own dark', () => {
		const ui = postcss.parse( sass.compile( UI_ENTRY ).css, {
			from: UI_ENTRY,
		} );
		const heading = mergedDeclarationsForSelectors(
			ui,
			( selector ) =>
				'.newspack-nodes-ui.newspack-nodes-ui .form-table th' ===
				selector
		);
		expect( heading?.color ).toBe( 'var(--np-field-label)' );
		expect(
			mergedDeclarationsForSelectors(
				ui,
				( selector ) =>
					'.newspack-nodes-ui.newspack-nodes-ui' === selector
			)?.[ '--np-field-label' ]
		).toBe( 'var(--ink-2, var(--np-text))' );
	} );
} );

describe( 'WordPress notices in a skinned page', () => {
	const ui = postcss.parse( sass.compile( UI_ENTRY ).css, {
		from: UI_ENTRY,
	} );
	const of = ( selector ) =>
		mergedDeclarationsForSelectors(
			ui,
			( candidate ) => `.newspack-nodes-ui ${ selector }` === candidate
		);

	it( 'seats a notice on the lightest rung in the skin ink', () => {
		expect( of( '.notice' ) ).toMatchObject( {
			background: 'var(--paper, var(--np-surface))',
			color: 'var(--ink, var(--np-text))',
		} );
	} );

	it.each( [
		[ 'success', 'var(--sage, var(--np-success))' ],
		[ 'warning', 'var(--brass, var(--np-warning))' ],
		[ 'error', 'var(--oxide, var(--np-error))' ],
		[ 'info', 'var(--cyan, var(--np-primary))' ],
	] )( 'edges a %s notice in its status colour', ( tone, color ) => {
		expect( of( `.notice-${ tone }` )?.[ 'border-left-color' ] ).toBe(
			color
		);
	} );
} );

describe( 'stock tables and the shared mixins', () => {
	const ui = postcss.parse( sass.compile( UI_ENTRY ).css, {
		from: UI_ENTRY,
	} );
	const of = ( selector ) =>
		mergedDeclarationsForSelectors(
			ui,
			( candidate ) =>
				`.newspack-nodes-ui.newspack-nodes-ui ${ selector }` ===
				candidate
		);

	it( 'seats a stock table on the canonical table surface, striped as one', () => {
		const SURFACE =
			'var(--nodes-table-surface, var(--paper-2, var(--np-surface-subtle)))';
		expect( of( '.widefat' )?.background ).toBe( SURFACE );
		expect( of( '.widefat tbody tr:nth-child(odd)' )?.background ).toBe(
			`color-mix(in srgb, var(--ink, var(--np-text)) 8%, ${ SURFACE })`
		);
	} );

	it( 'declares no mixin that nothing includes', () => {
		const source = fs.readFileSync(
			path.join( NODES_SRC, 'shared/styles/_mixins.scss' ),
			'utf8'
		);
		expect( source ).not.toMatch(
			/@mixin (?:table-header|widefat-themed)\b/
		);
	} );
} );

describe( 'the type scale floor', () => {
	const {
		stylesheetOffenders,
		scriptOffenders,
	} = require( '../../../build-kit/type-scale-floor.cjs' );

	it( 'sets no UI type below --np-text-2xs in a stylesheet', () => {
		const offenders = walkScss( NODES_SRC )
			.filter( ( file ) => ! path.basename( file ).startsWith( '_' ) )
			.flatMap( ( file ) =>
				stylesheetOffenders(
					compile( file ),
					path.relative( NODES_SRC, file )
				)
			);
		expect( offenders ).toEqual( [] );
	} );

	// A d3 chart or an inline style sets type from a script.
	it( 'sets no UI type below --np-text-2xs from a script', () => {
		const offenders = walkJavaScript( NODES_SRC )
			.filter( ( file ) => ! file.includes( `${ path.sep }test-utils` ) )
			.flatMap( ( file ) =>
				scriptOffenders(
					fs.readFileSync( file, 'utf8' ),
					path.relative( NODES_SRC, file )
				)
			);
		expect( offenders ).toEqual( [] );
	} );
} );
