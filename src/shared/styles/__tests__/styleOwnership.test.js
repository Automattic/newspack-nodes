/* @jest-environment node */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import * as sass from 'sass';
// Babel/Jest already installs the parser used for source-level JSX ownership.
// eslint-disable-next-line import/no-extraneous-dependencies
import { parse as parseJavaScript } from '@babel/parser';
// postcss-scss declares PostCSS as a required peer; this file parses
// source-compiled CSS and source SCSS.
// eslint-disable-next-line import/no-extraneous-dependencies
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
const SHARED_ALIAS = '@newspack-nodes/shared';
const graphStylesheet = postcss.parse(
	sass.compile( GRAPH_VIEW, {
		importers: [
			{
				findFileUrl( url ) {
					if (
						url !== SHARED_ALIAS &&
						! url.startsWith( `${ SHARED_ALIAS }/` )
					) {
						return null;
					}
					const relative = url
						.slice( SHARED_ALIAS.length )
						.replace( /^\/+/, '' );
					return pathToFileURL(
						path.join( NODES_SRC, 'shared', relative )
					);
				},
			},
		],
	} ).css,
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
	'nodes-devtools__tab',
	'nodes-debug__fab',
	'newspack-nodes-log-browser__mode',
	'newspack-nodes-log-browser__mode--live',
	'newspack-nodes-log-browser__mode--replay',
	'newspack-nodes-log-browser__item',
	'newspack-nodes-modal__close',
	'newspack-nodes-disclosure',
	'newspack-nodes-rail-toggle',
	'topology-mode__btn',
	'topology-repl__toggle',
	'topology-repl__clear',
] );
const REQUIRED_ROLE_PAIRS = [
	[ 'nodes-card', 'newspack-nodes-card' ],
	[ 'nodes-topics', 'newspack-nodes-card' ],
	[ 'nodes-topics__tooltip', 'newspack-nodes-card' ],
	[ 'nodes-topics__tooltip', 'newspack-nodes-card--elevated' ],
	[ 'nodes-overview__stopped-item', 'newspack-nodes-badge' ],
	[ 'nodes-tm__topology', 'newspack-nodes-card' ],
	[ 'nodes-tm__expand', 'newspack-nodes-disclosure' ],
	[ 'nodes-tm__collapse', 'newspack-nodes-disclosure' ],
	[ 'caret', 'newspack-nodes-disclosure' ],
	[ 'nodes-tm__badge', 'newspack-nodes-status-badge' ],
	[ 'nodes-tm__badge', 'is-pill' ],
	[ 'aggregator-server-card', 'newspack-nodes-card' ],
	[ 'aggregator-server-card', 'newspack-nodes-card--elevated' ],
	[ 'aggregator-partition', 'newspack-nodes-card' ],
	[ 'aggregator-partition', 'newspack-nodes-card--hoverable' ],
	[ 'aggregator-partition-stat-label', 'newspack-nodes-stat-label' ],
	[ 'aggregator-partition-stat-value', 'newspack-nodes-stat-value' ],
	[ 'nodes-runtime__grid', 'newspack-nodes-table' ],
	[ 'topology-modal', 'newspack-nodes-modal' ],
	[ 'topology-settings-panel', 'newspack-nodes-card' ],
	[ 'topology-settings-panel', 'newspack-nodes-card--elevated' ],
	[ 'topology-open-item__badge', 'newspack-nodes-badge' ],
	[ 'nodes-vault__modal', 'newspack-nodes-modal' ],
	[ 'nodes-tm__alert', 'newspack-nodes-modal' ],
	[ 'nodes-devtools__empty', 'newspack-nodes-empty-state' ],
	[ 'nodes-devtools__lazy-loading', 'newspack-nodes-performance-loading' ],
	[ 'aggregator-status-loading', 'newspack-nodes-performance-loading' ],
	[ 'aggregator-status-empty', 'newspack-nodes-empty-state' ],
	[ 'nodes-jobs__empty', 'newspack-nodes-empty-state' ],
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
	[ 'aggregator-heartbeat-badge', 'newspack-nodes-status-badge' ],
	[ 'aggregator-heartbeat-rtt', 'newspack-nodes-status' ],
	[ 'topology-repl__status', 'newspack-nodes-status' ],
	[ 'topology-inspector__toggle', 'newspack-nodes-rail-toggle' ],
	[ 'topology-palette__toggle', 'newspack-nodes-rail-toggle' ],
	[ 'triage-view__status', 'newspack-nodes-status' ],
	[ 'test-status', 'newspack-nodes-status' ],
	[ 'nodes-vault__add-status', 'newspack-nodes-status' ],
	[ 'newspack-nodes-connection-banner', 'newspack-nodes-error-banner' ],
];
const SURFACE_SELECTORS = new Set( [
	'.nodes-card',
	'.nodes-debug__panel',
	'.nodes-topics',
	'.nodes-topics__tooltip',
	'.nodes-overview__stopped-item',
	'.nodes-tm__topology',
	'.nodes-tm__badge',
	'.aggregator-server-card',
	'.aggregator-partition',
	'.aggregator-partition:hover',
	'.aggregator-partition-stat-label',
	'.nodes-vault__modal',
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
const SHARED_IMPORTER = {
	findFileUrl( url ) {
		if (
			url !== SHARED_ALIAS &&
			! url.startsWith( `${ SHARED_ALIAS }/` )
		) {
			return null;
		}
		const relative = url.slice( SHARED_ALIAS.length ).replace( /^\/+/, '' );
		return pathToFileURL( path.join( NODES_SRC, 'shared', relative ) );
	},
};

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

const declarationsForSelector = ( stylesheet, selector ) => {
	let declarations;
	stylesheet.walkRules( ( rule ) => {
		if ( rule.selectors.includes( selector ) ) {
			declarations = Object.fromEntries(
				rule.nodes
					.filter( ( node ) => 'decl' === node.type )
					.map( ( declaration ) => [
						declaration.prop,
						declaration.value,
					] )
			);
		}
	} );
	return declarations;
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

	it( 'exports only live aggregator Sass tokens and compiles their consumer', () => {
		const stylesDir = path.join( NODES_SRC, 'event-aggregator/styles' );
		const basePath = path.join( stylesDir, 'base.scss' );
		const baseSource = fs.readFileSync( basePath, 'utf8' );
		const consumerPaths = walkScss( stylesDir ).filter(
			( file ) => file !== basePath
		);
		const exported = [ ...baseSource.matchAll( /^\$([\w-]+)\s*:/gm ) ]
			.map( ( match ) => match[ 1 ] )
			.sort();
		const consumed = [
			...new Set(
				consumerPaths.flatMap( ( file ) =>
					[
						...fs
							.readFileSync( file, 'utf8' )
							.matchAll( /base\.\$([\w-]+)/g ),
					].map( ( match ) => match[ 1 ] )
				)
			),
		].sort();
		const mixins = [ ...baseSource.matchAll( /@mixin\s+([\w-]+)/g ) ].map(
			( match ) => match[ 1 ]
		);

		expect( consumed ).toEqual( [
			'border-radius-sm',
			'error-text',
			'mono-font',
			'system-font',
		] );
		expect( exported ).toEqual( consumed );
		expect( mixins ).toEqual( [] );
		for ( const consumerPath of consumerPaths ) {
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
					'.aggregator-heartbeat-badge',
					'.aggregator-heartbeat-badge.small',
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
					'rtt-value',
					'rtt-unit',
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
			'.aggregator-status-badge.connecting',
			'.aggregator-status-badge.backoff',
			'.aggregator-status-badge.connection_refused',
			'.aggregator-status-badge.error',
			'.aggregator-status-badge.ssl_error',
			'.aggregator-status-badge.auth_failed',
			'.aggregator-heartbeat-badge.slot_expired',
			'.aggregator-heartbeat-badge.error',
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
			'--nodes-devtools-fg',
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
			'.topology-modal__close',
			'.topology-modal__input',
		] ) {
			expect( selectors ).toContain( selector );
		}

		for ( const legacySelector of [
			'.topology-app .button.is-compact',
			'.topology-app .topology-edit-row__input',
			'.topology-app .topology-modal__close',
			'.topology-app .topology-modal__input',
		] ) {
			expect( selectors ).not.toContain( legacySelector );
		}
		expect(
			selectors.filter( ( selector ) =>
				selector.includes( '.topology-modal__close:hover' )
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

		expect(
			declarationsForSelector(
				triageViewStylesheet,
				':is(.topology-app, .topology-modal) .triage-view__grid .button.is-compact'
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
			'.topology-modal__close': [
				'background',
				'border',
				'border-radius',
				'color',
				'cursor',
				'font-family',
				'transition',
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
				'devtools-hub/devtools-hub.scss',
				'nodes-devtools__empty',
				{ padding: '0' },
			],
			[
				'event-aggregator/styles/aggregator-status.scss',
				'aggregator-status-empty',
				{ padding: '48px 24px', 'text-align': 'center' },
			],
			[
				'event-dashboards/styles/jobs.scss',
				'nodes-jobs__empty',
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
		const devtoolsStylesheet = compile(
			path.join( NODES_SRC, 'devtools-hub/devtools-hub.scss' )
		);
		expect(
			declarationsForSelector(
				devtoolsStylesheet,
				'.newspack-nodes-performance-loading.nodes-devtools__lazy-loading'
			)
		).toEqual(
			expect.objectContaining( {
				display: 'block',
				'min-height': '0',
				padding: '24px',
			} )
		);
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
		expect(
			declarationsForSelector( inspectorViewsStylesheet, runtimeSelector )
		).toEqual(
			expect.objectContaining( {
				'font-size': 'inherit',
				'line-height': 'inherit',
			} )
		);
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
					selectorHasClass( selector, 'nodes-devtools__tab' ) &&
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
				'font-size': '10px',
				'line-height': '1.2',
				'margin-bottom': '0',
				'vertical-align': 'baseline',
			} )
		);

		const graphButtonHeights = [
			[ 'topology-canvas__layout-chip', 'auto' ],
			[ 'topology-edit-row__reset', 'auto' ],
			[ 'topology-hull-panel__open', 'auto' ],
			[ 'topology-edit-verb__remove', '20px' ],
			[ 'topology-field-row__nav', 'auto' ],
			[ 'topology-edit-chip__clear', 'auto' ],
			[ 'topology-edit-delete', 'auto' ],
			[ 'topology-edit-verb__add', 'auto' ],
			[ 'topology-insp__listener-x', 'auto' ],
			[ 'topology-palette__search-clear', 'auto' ],
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
		for ( const className of [
			'topology-open-item',
			'topology-settings-panel__close',
		] ) {
			expect(
				declarationsForRepeatedButtonClass(
					consoleStylesheet,
					className
				)
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
			[
				'event-dashboards/styles/summary-cards.scss',
				'.nodes-card',
				'11px 15px',
			],
			[
				'event-dashboards/styles/overview.scss',
				'.nodes-topics',
				'9px 11px',
			],
			[
				'event-dashboards/styles/overview.scss',
				'.nodes-topics__tooltip',
				'7px 11px',
			],
			[
				'event-dashboards/styles/topology-row.scss',
				'.nodes-tm__topology',
				'1px',
			],
			[
				'event-aggregator/styles/aggregator-status.scss',
				'.aggregator-server-card',
				'17px 21px',
			],
			[
				'event-aggregator/styles/aggregator-status.scss',
				'.aggregator-partition',
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

	it( 'preserves compact Aggregator row geometry without local label sizing', () => {
		const stylesheet = compile(
			path.join(
				NODES_SRC,
				'event-aggregator/styles/aggregator-status.scss'
			)
		);

		expect(
			declarationsForSelector( stylesheet, '.aggregator-partition-row' )
		).toEqual( expect.objectContaining( { 'font-size': '11px' } ) );
		expect(
			declarationsForSelector(
				stylesheet,
				'.aggregator-partition-stat-label'
			)
		).toBeUndefined();
		expect(
			declarationsForSelector(
				stylesheet,
				'.aggregator-partition-stat-value'
			)
		).toEqual( {
			'font-family': 'var(--np-font-mono)',
			display: 'flex',
			'align-items': 'center',
			gap: '6px',
		} );
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

		expect(
			declarationsForSelector( graphStylesheet, '.topology-modal' )
		).toEqual(
			expect.objectContaining( {
				'min-width': '360px',
				'max-width': '560px',
			} )
		);
		expect(
			declarationsForSelector( graphStylesheet, '.topology-modal__close' )
		).toEqual(
			expect.objectContaining( {
				width: '24px',
				height: '24px',
				padding: '0',
			} )
		);

		const vaultStylesheet = compile(
			path.join( NODES_SRC, 'vault/vault-admin.scss' )
		);
		expect(
			declarationsForSelector( vaultStylesheet, '.nodes-vault__modal' )
		).toEqual(
			expect.objectContaining( {
				width: '90%',
				'max-width': '640px',
				'max-height': '90vh',
				padding: '24px',
			} )
		);
	} );

	// auto-fit, so the lone Open button still fills the row when the panel
	// offers no removal (view mode, or an include this file doesn't declare).
	it( 'sizes the hull panel actions as one even row', () => {
		expect(
			declarationsForSelector(
				graphStylesheet,
				'.topology-hull-panel__actions'
			)
		).toEqual(
			expect.objectContaining( {
				display: 'grid',
				'grid-template-columns': 'repeat(auto-fit, minmax(0, 1fr))',
				gap: '8px',
			} )
		);
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
	// that actually remove something carry the danger role, as a red circle.
	it( 'reserves the danger role for controls that destroy something', () => {
		const CLEARS = [
			'topology-edit-row__reset',
			'topology-palette__search-clear',
			'topology-edit-chip__clear',
			'topology-settings-panel__close',
		];
		const DESTROYS = [
			'topology-edit-verb__remove',
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

	// A table is a content surface like a card, not an elevated one.
	it( 'seats a table on the same surface as a card', () => {
		const ui = compile( UI_ENTRY );
		expect(
			declarationsForSelector(
				ui,
				':where(.newspack-nodes-ui) .newspack-nodes-table'
			).background
		).toBe(
			declarationsForSelector(
				ui,
				':where(.newspack-nodes-ui) .newspack-nodes-card'
			).background
		);
	} );

	// Both table paths stripe with one formula, and no row is painted the
	// table's own surface — that renders as no stripe at all.
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
				'max-height': '100%',
				display: 'flex',
				'flex-direction': 'column',
			} )
		);
		expect(
			declarationsForSelector( graphStylesheet, '.topology-modal__body' )
		).toEqual(
			expect.objectContaining( {
				'overflow-y': 'auto',
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
 * whole width. The Save-topology modal did exactly that.
 *
 * `_buttons.scss` already sets it beside its own border and padding; the field
 * rule is the one that omitted it.
 */
describe( 'shared field chrome', () => {
	const uiStylesheet = postcss.parse( sass.compile( UI_ENTRY ).css, {
		from: UI_ENTRY,
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
} );
