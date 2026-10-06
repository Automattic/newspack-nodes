/* @jest-environment node */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import {
	compare as compareSpecificity,
	selectorSpecificity,
} from '@csstools/selector-specificity';
import * as sass from 'sass';
import { JSDOM } from 'jsdom';
import selectorParser from 'postcss-selector-parser';
import { THEMES } from '../../shared/theme';
// Babel/Jest already installs the parser used to discover real SVG text nodes.
// eslint-disable-next-line import/no-extraneous-dependencies
import { parse as parseJavaScript } from '@babel/parser';
import postcss from 'postcss';

const ROOT = path.resolve( __dirname, '../../..' );
const THEME_SCSS = path.join( ROOT, 'src/theme/newspack-theme.scss' );
const UI_SCSS = path.join( ROOT, 'src/ui/newspack-nodes-ui.scss' );
const GRAPH_SCSS = path.join(
	ROOT,
	'src/topology-console/styles/graph-view.scss'
);
const FORMAT_UTILS_JS = path.join( ROOT, 'src/shared/utils/formatUtils.js' );
const SCHEMATIC_CANVAS = path.join(
	ROOT,
	'src/topology-console/components/SchematicCanvas.js'
);
const SKINS_SCSS = path.join( ROOT, 'src/theme/_skins.scss' );
const compiledTheme = sass.compile( THEME_SCSS ).css;
const stylesheet = postcss.parse( compiledTheme, { from: THEME_SCSS } );
const uiStylesheet = postcss.parse( sass.compile( UI_SCSS ).css, {
	from: UI_SCSS,
} );
const graphStylesheet = postcss.parse( sass.compile( GRAPH_SCSS ).css, {
	from: GRAPH_SCSS,
} );

const EXPECTED_SKINS = THEMES.map( ( { slug } ) => slug );
const REQUIRED_SKIN_ROLES = [
	'--paper',
	'--paper-2',
	'--paper-3',
	'--paper-shadow',
	'--canvas',
	'--hover',
	'--ink',
	'--ink-2',
	'--ink-3',
	'--ink-4',
	'--grid',
	'--oxide',
	'--oxide-dark',
	'--brass',
	'--brass-dark',
	'--cyan',
	'--cyan-dark',
	'--sage',
	'--sage-dark',
	'--repl-bg',
	'--repl-fg',
	'--font-mono',
	'--font-display-brand',
	'--font-display-stencil',
];
const PAPER_ROLES = [ '--paper', '--paper-2', '--paper-3' ];
// Every role that PAINTS a surface rather than drawing a line over one. A
// translucent value here reads whatever sits behind the skin — the WP-admin
// page under a dashboard, the page under a dialog — so each must be opaque.
// `--grid` is deliberately absent: it is a rule drawn over the canvas.
const OPAQUE_SURFACE_ROLES = [ ...PAPER_ROLES, '--paper-shadow', '--repl-bg' ];
const INK_ROLES = [ '--ink', '--ink-2', '--ink-3', '--ink-4' ];
const MINIMUM_TEXT_CONTRAST = 4.5;
const CONTRAST_FOREGROUND_TOKENS = new Set( [
	'--on-cyan',
	'--on-cyan-dark',
	'--on-oxide',
	'--on-oxide-dark',
	'--on-brass',
	'--on-brass-dark',
	'--on-sage',
	'--cyan-text',
	'--brass-text',
	'--sage-text',
	'--oxide-text',
] );
const COMMON_DERIVED_TOKENS = {
	'--modal-radius': '5px',
	'--modal-shadow': 'none',
	'--oxide-subtle': 'color-mix(in srgb, var(--oxide) 12%, var(--paper))',
	'--sage-subtle': 'color-mix(in srgb, var(--sage) 15%, var(--paper))',
	'--brass-subtle': 'color-mix(in srgb, var(--brass) 14%, var(--paper))',
	'--cyan-subtle': 'color-mix(in srgb, var(--cyan) 10%, var(--paper))',
	'--chart-1': 'var(--cyan)',
	'--chart-2': 'var(--sage)',
	'--chart-3': 'var(--brass)',
	'--chart-4': 'var(--oxide)',
	'--chart-5': 'var(--cyan-dark)',
	'--chart-6': 'var(--sage-dark)',
	'--chart-7': 'var(--brass-dark)',
	'--chart-8': 'var(--oxide-dark)',
	'--on-cyan': 'var(--paper)',
	'--on-cyan-dark': 'var(--paper)',
	'--on-oxide': 'var(--paper)',
	'--on-oxide-dark': 'var(--paper)',
	'--on-brass': 'var(--paper)',
	'--on-brass-dark': 'var(--paper)',
	'--on-sage': 'var(--paper)',
	'--cyan-text': 'color-mix(in srgb, var(--cyan) 20%, var(--ink))',
	'--brass-text': 'color-mix(in srgb, var(--brass) 15%, var(--ink))',
	'--sage-text': 'color-mix(in srgb, var(--sage) 20%, var(--ink))',
	'--oxide-text': 'color-mix(in srgb, var(--oxide) 20%, var(--ink))',
	'--status-text': 'color-mix(in srgb, var(--ink) 45%, var(--ink-2))',
	'--muted-text': 'color-mix(in srgb, var(--status-text) 60%, var(--ink-3))',
	'--font-terminal': 'var(--font-mono)',
};
const ALLOWED_DERIVED_OVERRIDES = {
	newspack: {
		'--chart-1': 'var(--np-chart-1)',
		'--chart-2': 'var(--np-chart-2)',
		'--chart-3': 'var(--np-chart-3)',
		'--chart-4': 'var(--np-chart-4)',
		'--chart-5': 'var(--np-chart-5)',
		'--chart-6': 'var(--np-chart-6)',
		'--chart-7': 'var(--np-chart-7)',
		'--chart-8': 'var(--np-chart-8)',
		'--font-terminal': 'var(--np-font-mono)',
		'--modal-radius': '6px',
		'--modal-shadow': '0 3px 30px rgba(0, 0, 0, 0.7019607843137254)',
		'--muted-text': '#717171',
		'--status-text': '#666',
	},
	'newspack-brand': {
		'--chart-1': 'var(--np-chart-1)',
		'--chart-2': 'var(--np-chart-2)',
		'--chart-3': 'var(--np-chart-3)',
		'--chart-4': 'var(--np-chart-4)',
		'--chart-5': 'var(--np-chart-5)',
		'--chart-6': 'var(--np-chart-6)',
		'--chart-7': 'var(--np-chart-7)',
		'--chart-8': 'var(--np-chart-8)',
		'--font-terminal': '"jetbrains mono", ui-monospace, monospace',
		'--modal-radius': '6px',
		'--modal-shadow': '0 3px 30px rgba(0, 0, 0, 0.7019607843137254)',
		'--muted-text': '#717171',
		'--status-text': '#666',
	},
	synthwave: {
		'--font-terminal': '"spline sans mono", monospace',
	},
	botanical: {
		'--font-terminal': '"spline sans mono", monospace',
	},
};
const EXPECTED_SEMANTIC_TEXT_OVERRIDES = {
	newspack: {
		'--cyan-text': 'var(--cyan)',
		'--brass-text': '#765400',
		'--sage-text': 'var(--sage)',
		'--oxide-text': 'var(--oxide)',
	},
	'newspack-brand': {
		'--cyan-text': 'var(--cyan)',
		'--brass-text': '#855400',
		'--sage-text': 'var(--sage-dark)',
		'--oxide-text': 'var(--oxide-dark)',
	},
};
const STOCK_MODAL_SHADOW =
	'0 5px 15px rgba(0, 0, 0, 0.08), 0 15px 27px rgba(0, 0, 0, 0.07), 0 30px 36px rgba(0, 0, 0, 0.04), 0 50px 43px rgba(0, 0, 0, 0.02)';
const NEWSPACK_MODAL_SHADOW = '0 3px 30px rgba(0, 0, 0, 0.7019607843137254)';

const EXACT_ANCHORS = {
	newspack: {
		'--paper': '#fff',
		'--paper-2': '#f7f7f7',
		'--paper-3': '#f0f0f0',
		'--paper-shadow': '#ccc',
		'--ink': '#111',
		'--ink-2': '#393939',
		'--ink-3': '#515151',
		'--ink-4': '#6c6c6c',
	},
	'newspack-brand': {
		'--paper': '#fff',
		'--paper-2': '#f7f7f7',
		'--paper-3': '#f0f0f0',
		'--paper-shadow': '#ddd',
		'--ink': '#1e1e1e',
		'--ink-2': '#3e3e3e',
		'--ink-3': '#6c6c6c',
		'--ink-4': '#949494',
	},
	swiss: {
		'--paper': '#fff',
		'--paper-2': '#f9f9f9',
		'--paper-3': '#f2f2f2',
		'--ink': '#0a0a0a',
		'--ink-2': '#2a2a2a',
		'--ink-3': '#4a4a4a',
		'--ink-4': '#6b6b6b',
	},
	bauhaus: {
		'--ink': '#111',
		'--ink-2': '#333',
		'--ink-3': '#555',
		'--ink-4': '#6b6b6b',
	},
};

const normalizeSelector = ( selector ) =>
	selector
		.replace( /\s+/g, ' ' )
		.replace( /\s*,\s*/g, ',' )
		.trim();

const declarations = ( rule ) =>
	Object.fromEntries(
		( rule.nodes || [] )
			.filter(
				( node ) => 'decl' === node.type && node.prop.startsWith( '--' )
			)
			.map( ( declaration ) => [
				declaration.prop,
				declaration.value.trim().toLowerCase(),
			] )
	);

const allDeclarations = ( rule ) =>
	Object.fromEntries(
		( rule.nodes || [] )
			.filter( ( node ) => 'decl' === node.type )
			.map( ( declaration ) => [
				declaration.prop,
				declaration.value.trim().toLowerCase(),
			] )
	);

const cascadeRecords = ( cssRoot ) => {
	const records = [];
	let sourceOrder = 0;
	cssRoot.walkRules( ( rule ) => {
		if (
			'atrule' === rule.parent?.type &&
			rule.parent.name.endsWith( 'keyframes' )
		) {
			return;
		}
		for ( const declaration of ( rule.nodes || [] ).filter(
			( node ) => 'decl' === node.type
		) ) {
			for ( const selector of rule.selectors ) {
				const normalized = normalizeSelector( selector );
				const selectorNode =
					selectorParser().astSync( normalized ).nodes[ 0 ];
				const conditions = [];
				let parent = rule.parent;
				while ( parent && 'root' !== parent.type ) {
					if ( 'atrule' === parent.type ) {
						conditions.unshift(
							`@${ parent.name } ${ parent.params }`.trim()
						);
					}
					parent = parent.parent;
				}
				records.push( {
					conditions,
					important: declaration.important,
					property: declaration.prop,
					selector: normalized,
					sourceOrder,
					specificity: selectorSpecificity( selectorNode ),
					value: declaration.value.trim().toLowerCase(),
				} );
			}
			sourceOrder++;
		}
	} );
	return records;
};

const themeTokens = {};
const skinRules = [];
const commonRules = [];
const bareThemeRules = [];
stylesheet.walkRules( ( rule ) => {
	const selector = normalizeSelector( rule.selector );
	if ( '.newspack-nodes-theme' === selector ) {
		Object.assign( themeTokens, declarations( rule ) );
		bareThemeRules.push( allDeclarations( rule ) );
	}
	if (
		':is(.topology-app,.newspack-nodes-skin-root).newspack-nodes-theme' ===
		selector
	) {
		commonRules.push( declarations( rule ) );
	}
	const match =
		/^\.theme-([a-z0-9-]+) :is\(\.topology-app,\.newspack-nodes-skin-root\)\.newspack-nodes-theme$/.exec(
			selector
		);
	if ( match ) {
		skinRules.push( {
			slug: match[ 1 ],
			tokens: declarations( rule ),
		} );
	}
} );
const skinMaps = new Map(
	skinRules.map( ( { slug, tokens } ) => [ slug, tokens ] )
);
const uiRules = [];
uiStylesheet.walkRules( ( rule ) => {
	uiRules.push( {
		selector: normalizeSelector( rule.selector ),
		selectors: rule.selectors.map( normalizeSelector ),
		declarations: allDeclarations( rule ),
	} );
} );
const graphRules = [];
graphStylesheet.walkRules( ( rule ) => {
	graphRules.push( {
		selector: normalizeSelector( rule.selector ),
		selectors: rule.selectors.map( normalizeSelector ),
		declarations: allDeclarations( rule ),
	} );
} );
const graphCascadeRecords = cascadeRecords( graphStylesheet );
const uiCascadeRecords = cascadeRecords( uiStylesheet );
// WordPress's component stylesheet, which wp-admin loads ahead of the UI asset.
const WORDPRESS_COMPONENTS_CSS = path.join(
	ROOT,
	'node_modules/@wordpress/components/build-style/style.css'
);
// jsdom cannot parse WordPress's nested :has(), and none matches a lone button.
const wordpressUiCascadeRecords = cascadeRecords(
	postcss.parse(
		`${ fs.readFileSync( WORDPRESS_COMPONENTS_CSS, 'utf8' ) }\n${
			sass.compile( UI_SCSS ).css
		}`
	)
).filter( ( record ) => ! record.selector.includes( ':has(' ) );
const skinsSource = fs.readFileSync( SKINS_SCSS, 'utf8' );

const effectiveSkin = ( slug ) => ( {
	...( commonRules[ 0 ] || {} ),
	...( skinMaps.get( slug ) || {} ),
} );

const firstVarToken = ( value ) =>
	/^var\(\s*(--[a-z0-9-]+)/i.exec( value || '' )?.[ 1 ] || null;

const compactWhitespace = ( value = '' ) => value.replace( /\s+/g, ' ' ).trim();

const walkFiles = ( root, accept ) =>
	fs.readdirSync( root, { withFileTypes: true } ).flatMap( ( entry ) => {
		const absolute = path.join( root, entry.name );
		if ( entry.isDirectory() ) {
			return '__tests__' === entry.name
				? []
				: walkFiles( absolute, accept );
		}
		return accept( entry.name ) ? [ absolute ] : [];
	} );

const SHARED_ALIAS = '@newspack-nodes/shared';
const sharedImporter = {
	findFileUrl( url ) {
		if (
			url !== SHARED_ALIAS &&
			! url.startsWith( `${ SHARED_ALIAS }/` )
		) {
			return null;
		}
		const relative = url.slice( SHARED_ALIAS.length ).replace( /^\/+/, '' );
		return pathToFileURL( path.join( ROOT, 'src/shared', relative ) );
	},
};

const productionStylePaths = new Set( [ THEME_SCSS, UI_SCSS, GRAPH_SCSS ] );
for ( const file of walkFiles( path.join( ROOT, 'src' ), ( name ) =>
	/\.(?:js|jsx)$/.test( name )
) ) {
	const source = fs.readFileSync( file, 'utf8' );
	for ( const match of source.matchAll(
		/import\s+['"]([^'"]+\.scss)['"]/g
	) ) {
		productionStylePaths.add(
			path.resolve( path.dirname( file ), match[ 1 ] )
		);
	}
}

const productionRules = [];
for ( const file of [ ...productionStylePaths ].sort() ) {
	const productionStylesheet = postcss.parse(
		sass.compile( file, { importers: [ sharedImporter ] } ).css,
		{ from: file }
	);
	productionStylesheet.walkRules( ( rule ) => {
		productionRules.push( {
			declarations: allDeclarations( rule ),
			file,
			selector: normalizeSelector( rule.selector ),
			selectors: rule.selectors.map( normalizeSelector ),
		} );
	} );
}

const walkAst = ( node, visit ) => {
	if ( ! node || 'object' !== typeof node ) {
		return;
	}
	visit( node );
	for ( const value of Object.values( node ) ) {
		if ( Array.isArray( value ) ) {
			value.forEach( ( child ) => walkAst( child, visit ) );
		} else if ( value && 'object' === typeof value && value.type ) {
			walkAst( value, visit );
		}
	}
};

const staticJsxAttribute = ( node, name ) =>
	node.attributes.find(
		( attribute ) =>
			'JSXAttribute' === attribute.type && name === attribute.name?.name
	);

const staticClassNames = ( node ) => {
	const attribute = staticJsxAttribute( node, 'className' );
	if ( 'StringLiteral' === attribute?.value?.type ) {
		return attribute.value.value.split( /\s+/ ).filter( Boolean );
	}
	const expression = attribute?.value?.expression;
	return 'TemplateLiteral' === expression?.type
		? expression.quasis.flatMap( ( quasi ) =>
				quasi.value.cooked.split( /\s+/ ).filter( Boolean )
		  )
		: [];
};

const numericJsxAttribute = ( node, name ) => {
	const attribute = staticJsxAttribute( node, name );
	const value = attribute?.value;
	if ( 'StringLiteral' === value?.type ) {
		return Number( value.value );
	}
	if (
		'JSXExpressionContainer' === value?.type &&
		'NumericLiteral' === value.expression?.type
	) {
		return value.expression.value;
	}
	return null;
};

const schematicNodeGraphicRecords = [];
const schematicNodeStateClasses = new Set();
const schematicTextRecords = [];
let schematicHeaderHeight = null;
const schematicSource = fs.readFileSync( SCHEMATIC_CANVAS, 'utf8' );
const schematicAst = parseJavaScript( schematicSource, {
	sourceType: 'module',
	plugins: [ 'jsx' ],
} );
walkAst( schematicAst, ( node ) => {
	if (
		'JSXOpeningElement' !== node.type ||
		'JSXIdentifier' !== node.name.type
	) {
		return;
	}
	const classes = staticClassNames( node );
	const classExpression = staticJsxAttribute( node, 'className' )?.value
		?.expression;
	if (
		'g' === node.name.name &&
		'TemplateLiteral' === classExpression?.type &&
		classExpression.quasis.some( ( quasi ) =>
			quasi.value.cooked.includes( 'topology-node' )
		)
	) {
		walkAst( classExpression, ( child ) => {
			if (
				'StringLiteral' === child.type &&
				/^ is-[a-z-]+$/.test( child.value )
			) {
				schematicNodeStateClasses.add( child.value.trim() );
			}
		} );
	}
	if (
		'rect' === node.name.name &&
		classes.includes( 'topology-node__header' )
	) {
		schematicHeaderHeight = numericJsxAttribute( node, 'height' );
	}
	if ( 'text' === node.name.name ) {
		classes.forEach( ( className ) =>
			schematicTextRecords.push( {
				className,
				y: numericJsxAttribute( node, 'y' ),
			} )
		);
	}
	if ( [ 'rect', 'line', 'circle', 'path' ].includes( node.name.name ) ) {
		classes
			.filter(
				( className ) =>
					className.startsWith( 'topology-node__' ) ||
					'topology-port' === className
			)
			.forEach( ( className ) =>
				schematicNodeGraphicRecords.push( {
					className,
					tag: node.name.name,
				} )
			);
	}
} );
const productionRule = ( predicate ) =>
	uiRules.find( ( rule ) => predicate( rule.selector ) );

const resolveValue = ( value, skin, seen = new Set() ) => {
	if ( 'string' !== typeof value ) {
		return null;
	}
	const match = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec( value );
	if ( ! match ) {
		return value;
	}
	const token = match[ 1 ];
	if ( seen.has( token ) ) {
		return null;
	}
	const next = skin[ token ] ?? themeTokens[ token ];
	if ( 'string' !== typeof next ) {
		return null;
	}
	return resolveValue( next, skin, new Set( [ ...seen, token ] ) );
};

const parseChannel = ( value ) =>
	value.endsWith( '%' )
		? ( Number.parseFloat( value ) / 100 ) * 255
		: Number.parseFloat( value );

const parseAlpha = ( value = '1' ) =>
	value.endsWith( '%' )
		? Number.parseFloat( value ) / 100
		: Number.parseFloat( value );

const parseColor = ( value ) => {
	const normalized = String( value ).trim().toLowerCase();
	if ( 'transparent' === normalized ) {
		return { r: 0, g: 0, b: 0, a: 0 };
	}
	if ( 'black' === normalized ) {
		return { r: 0, g: 0, b: 0, a: 1 };
	}
	if ( 'white' === normalized ) {
		return { r: 255, g: 255, b: 255, a: 1 };
	}
	const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec( normalized );
	if ( hex ) {
		const expanded =
			4 >= hex[ 1 ].length
				? hex[ 1 ]
						.split( '' )
						.map( ( digit ) => digit + digit )
						.join( '' )
				: hex[ 1 ];
		return {
			r: Number.parseInt( expanded.slice( 0, 2 ), 16 ),
			g: Number.parseInt( expanded.slice( 2, 4 ), 16 ),
			b: Number.parseInt( expanded.slice( 4, 6 ), 16 ),
			a:
				8 === expanded.length
					? Number.parseInt( expanded.slice( 6, 8 ), 16 ) / 255
					: 1,
		};
	}

	const functional = /^rgba?\((.*)\)$/.exec( normalized );
	if ( ! functional ) {
		return null;
	}
	let channels;
	let alpha;
	if ( functional[ 1 ].includes( ',' ) ) {
		const parts = functional[ 1 ]
			.split( ',' )
			.map( ( part ) => part.trim() );
		channels = parts.slice( 0, 3 );
		alpha = parts[ 3 ];
	} else {
		const [ channelText, alphaText ] = functional[ 1 ].split(
			/\s*\/\s*/,
			2
		);
		channels = channelText.trim().split( /\s+/ );
		alpha = alphaText;
	}
	if ( 3 !== channels.length ) {
		return null;
	}
	const color = {
		r: parseChannel( channels[ 0 ] ),
		g: parseChannel( channels[ 1 ] ),
		b: parseChannel( channels[ 2 ] ),
		a: parseAlpha( alpha ),
	};
	if (
		! Object.values( color ).every( Number.isFinite ) ||
		[ color.r, color.g, color.b ].some(
			( channel ) => 0 > channel || 255 < channel
		) ||
		0 > color.a ||
		1 < color.a
	) {
		return null;
	}
	return color;
};

const composite = ( foreground, background ) => {
	const alpha = foreground.a + background.a * ( 1 - foreground.a );
	const mix = ( channel ) =>
		0 === alpha
			? 0
			: ( foreground[ channel ] * foreground.a +
					background[ channel ] *
						background.a *
						( 1 - foreground.a ) ) /
			  alpha;
	return {
		r: mix( 'r' ),
		g: mix( 'g' ),
		b: mix( 'b' ),
		a: alpha,
	};
};

const withOpacity = ( color, opacity ) => ( {
	...color,
	a: color.a * opacity,
} );

const colorKey = ( color ) =>
	[ color.r, color.g, color.b, color.a ]
		.map( ( value ) => Number( value.toFixed( 6 ) ) )
		.join( ',' );

const linear = ( channel ) => {
	const value = channel / 255;
	return 0.04045 >= value
		? value / 12.92
		: ( ( value + 0.055 ) / 1.055 ) ** 2.4;
};

const luminance = ( color ) => {
	return (
		0.2126 * linear( color.r ) +
		0.7152 * linear( color.g ) +
		0.0722 * linear( color.b )
	);
};

const contrast = ( foreground, background ) => {
	const foregroundLuminance = luminance( foreground );
	const backgroundLuminance = luminance( background );
	return (
		( Math.max( foregroundLuminance, backgroundLuminance ) + 0.05 ) /
		( Math.min( foregroundLuminance, backgroundLuminance ) + 0.05 )
	);
};

const mixColors = ( foreground, background, foregroundWeight ) => {
	const backgroundWeight = 1 - foregroundWeight;
	const alpha =
		foreground.a * foregroundWeight + background.a * backgroundWeight;
	const channel = ( key ) =>
		( foreground[ key ] * foreground.a * foregroundWeight +
			background[ key ] * background.a * backgroundWeight ) /
		alpha;
	return {
		r: channel( 'r' ),
		g: channel( 'g' ),
		b: channel( 'b' ),
		a: alpha,
	};
};

const splitTopLevel = ( value ) => {
	const parts = [];
	let depth = 0;
	let start = 0;
	for ( let index = 0; index < value.length; index++ ) {
		if ( '(' === value[ index ] ) {
			depth++;
		} else if ( ')' === value[ index ] ) {
			depth--;
		} else if ( ',' === value[ index ] && 0 === depth ) {
			parts.push( value.slice( start, index ).trim() );
			start = index + 1;
		}
	}
	parts.push( value.slice( start ).trim() );
	return parts;
};

const weightedColor = ( value ) => {
	const weight = /\s+([\d.]+)%\s*$/.exec( value );
	return {
		value: weight ? value.slice( 0, weight.index ).trim() : value.trim(),
		weight: weight ? Number( weight[ 1 ] ) / 100 : null,
	};
};

const resolveCssColor = ( value, skin, seen = new Set() ) => {
	if ( 'string' !== typeof value ) {
		return null;
	}
	const normalized = value.trim().toLowerCase();
	if ( normalized.startsWith( 'var(' ) && normalized.endsWith( ')' ) ) {
		const [ token, fallback ] = splitTopLevel( normalized.slice( 4, -1 ) );
		if ( seen.has( token ) ) {
			return null;
		}
		const next = skin[ token ] ?? themeTokens[ token ] ?? fallback;
		return resolveCssColor( next, skin, new Set( [ ...seen, token ] ) );
	}
	if ( normalized.startsWith( 'color-mix(' ) && normalized.endsWith( ')' ) ) {
		const [ space, firstPart, secondPart ] = splitTopLevel(
			normalized.slice( 10, -1 )
		);
		if ( 'in srgb' !== space || ! firstPart || ! secondPart ) {
			return null;
		}
		const first = weightedColor( firstPart );
		const second = weightedColor( secondPart );
		let firstWeight = 0.5;
		if ( null !== first.weight ) {
			firstWeight = first.weight;
		} else if ( null !== second.weight ) {
			firstWeight = 1 - second.weight;
		}
		const firstColor = resolveCssColor( first.value, skin, seen );
		const secondColor = resolveCssColor( second.value, skin, seen );
		return firstColor && secondColor
			? mixColors( firstColor, secondColor, firstWeight )
			: null;
	}
	return parseColor( normalized );
};

const renderedColor = ( slug, color, background ) => {
	if ( 1 === color.a ) {
		return color;
	}
	if ( ! background ) {
		throw new Error( `${ slug } unexpectedly uses a translucent color` );
	}
	return composite( color, background );
};

const resolvedColor = ( skin, role ) =>
	resolveCssColor( `var(${ role })`, skin );

const foregroundContrast = ( slug, foreground, background ) =>
	contrast(
		renderedColor( slug, foreground, background ),
		renderedColor( slug, background )
	);

const resolvedColors = ( skin, roles ) => {
	const unresolved = {};
	const colors = roles.map( ( role ) => {
		const value = resolveValue( skin[ role ], skin );
		const color = null === value ? null : parseColor( value );
		if ( null === color ) {
			unresolved[ role ] = skin[ role ] ?? '<missing>';
		}
		return color;
	} );

	expect( unresolved ).toEqual( {} );
	return colors;
};

const paperColors = ( slug, skin ) => {
	const colors = resolvedColors( skin, PAPER_ROLES );
	expect(
		PAPER_ROLES.filter( ( role, index ) => 1 !== colors[ index ].a )
	).toEqual( [] );
	return colors;
};

const selectorHasClass = ( selector, className ) =>
	new RegExp(
		`\\.${ className.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ) }(?![\\w-])`
	).test( selector );

const selectorForFixture = ( selector ) =>
	selector.replace( /:hover\b/g, '[data-cascade-hover]' );

const winningDeclaration = ( records, element, property ) => {
	const properties = Array.isArray( property ) ? property : [ property ];
	let winner = null;
	for ( const candidate of records ) {
		if ( ! properties.includes( candidate.property ) ) {
			continue;
		}
		let matches;
		try {
			matches = element.matches(
				selectorForFixture( candidate.selector )
			);
		} catch ( error ) {
			throw new Error(
				`Cannot match compiled selector "${ candidate.selector }": ${ error.message }`
			);
		}
		if ( ! matches ) {
			continue;
		}
		if ( candidate.conditions.length ) {
			throw new Error(
				`Conditional declaration needs an explicit fixture condition: ${ candidate.conditions.join(
					' → '
				) } ${ candidate.selector } { ${ candidate.property }: ${
					candidate.value
				} }`
			);
		}
		if ( ! winner ) {
			winner = candidate;
			continue;
		}
		if ( candidate.important !== winner.important ) {
			if ( candidate.important ) {
				winner = candidate;
			}
			continue;
		}
		const specificity = compareSpecificity(
			candidate.specificity,
			winner.specificity
		);
		if (
			0 < specificity ||
			( 0 === specificity && candidate.sourceOrder > winner.sourceOrder )
		) {
			winner = candidate;
		}
	}
	return winner;
};

const createGraphFixture = ( slug, stateClass = '', hovered = false ) => {
	const dom = new JSDOM( `
			<!doctype html>
			<html class="theme-${ slug }">
				<body>
					<main class="topology-app newspack-nodes-theme newspack-nodes-ui">
						<section class="topology-canvas">
							<svg class="topology-canvas-svg">
								<g class="topology-nodes topology-nodes--bloom">
									<g class="topology-node ${ stateClass }"${
										hovered ? ' data-cascade-hover' : ''
									}>
										<rect class="topology-node__shadow"></rect>
										<rect class="topology-node__bg"></rect>
										<g clip-path="url(#topology-node-clip)">
										<rect class="topology-node__header"></rect>
										<line class="topology-node__divider"></line>
										<text class="topology-node__type" y="15"></text>
										<circle class="topology-node__led"></circle>
										<text class="topology-node__paused" y="17"></text>
										<text class="topology-node__lock" y="15"></text>
										<text class="topology-node__id" y="44"></text>
										</g>
										<circle class="topology-port topology-port--in"></circle>
										<circle class="topology-port topology-port--out"></circle>
									</g>
								</g>
								<g class="topology-readouts">
									<g class="topology-node-readout ${ stateClass }">
										<g clip-path="url(#topology-node-clip)">
										<path class="topology-node__spark"></path>
										<text class="topology-node__rate" y="76"></text>
										<text class="topology-node__counter" y="76"></text>
										</g>
									</g>
								</g>
							</svg>
					</section>
					<footer class="topology-repl">
						<div class="topology-repl__bar">
							<span class="topology-repl__prompt"></span>
						</div>
						<div class="topology-repl__transcript">
							<span class="topology-repl__entry topology-repl__entry--sent"></span>
							<span class="topology-repl__entry topology-repl__entry--error"></span>
						</div>
					</footer>
				</main>
			</body>
		</html>
	` );
	return dom.window.document;
};

const effectiveGraphDeclaration = ( slug, className, property ) => {
	const fixture = createGraphFixture( slug );
	const element = fixture.querySelector( `.${ className }` );
	return winningDeclaration( graphCascadeRecords, element, property )?.value;
};

const effectiveSurfaceColor = ( value, skin, underlay ) => {
	const surface = resolveCssColor( value, skin );
	const root = underlay || resolveCssColor( 'var(--paper-3)', skin );
	if ( ! surface || ! root ) {
		return null;
	}
	return 1 === surface.a ? surface : composite( surface, root );
};

const semanticForegroundValue = ( value ) =>
	/var\(--(?:cyan|brass|sage|oxide)(?:-text|-dark)?\s*[,)]/i.test(
		value || ''
	) ||
	/color-mix\([^;]*var\(--(?:cyan|brass|sage|oxide)/i.test( value || '' );

const paperTintSurface = ( value ) =>
	/^(?:var|color-mix)\(/i.test( value || '' ) &&
	/var\(--(?:paper(?:-[123])?|hover|(?:cyan|brass|sage|oxide)-subtle)\s*[,)]/i.test(
		value || ''
	);

const productionSemanticForegrounds = new Set(
	productionRules
		.map( ( rule ) => rule.declarations.color )
		.filter( ( value ) =>
			/var\(--(?:cyan|brass|sage|oxide)-text/.test( value || '' )
		)
);

const productionSemanticSurfacePairs = productionRules.flatMap( ( rule ) => {
	if ( ! semanticForegroundValue( rule.declarations.color ) ) {
		return [];
	}
	return [ 'background', 'background-color' ]
		.filter(
			( property ) =>
				undefined !== rule.declarations[ property ] &&
				paperTintSurface( rule.declarations[ property ] )
		)
		.map( ( property ) => ( {
			foreground: rule.declarations.color,
			selector: rule.selector,
			surface: rule.declarations[ property ],
		} ) );
} );

const schematicSemanticTextRecords = schematicTextRecords.filter(
	( { className } ) =>
		graphRules.some(
			( rule ) =>
				semanticForegroundValue( rule.declarations.fill ) &&
				rule.selectors.some( ( selector ) =>
					selectorHasClass( selector, className )
				)
		)
);

const graphValue = ( element, property ) =>
	winningDeclaration( graphCascadeRecords, element, property )?.value;

const inheritedGraphValue = ( element, property ) => {
	let current = element;
	while ( current ) {
		const value = graphValue( current, property );
		if ( undefined !== value ) {
			return value;
		}
		current = current.parentElement;
	}
	return undefined;
};

const resolveGraphScalar = ( value, element, seen = new Set() ) => {
	if ( 'string' !== typeof value ) {
		return null;
	}
	const normalized = value.trim().toLowerCase();
	if ( /^-?(?:\d+|\d*\.\d+)$/.test( normalized ) ) {
		return Number( normalized );
	}
	if ( normalized.startsWith( 'var(' ) && normalized.endsWith( ')' ) ) {
		const [ token, fallback ] = splitTopLevel( normalized.slice( 4, -1 ) );
		if ( seen.has( token ) ) {
			return null;
		}
		const next = inheritedGraphValue( element, token ) || fallback;
		return resolveGraphScalar(
			next,
			element,
			new Set( [ ...seen, token ] )
		);
	}
	return null;
};

const elementOpacity = ( element ) => {
	const value = graphValue( element, 'opacity' );
	return undefined === value ? 1 : resolveGraphScalar( value, element );
};

const nodeOpacityStateClasses = [ ...schematicNodeStateClasses ].filter(
	( className ) =>
		graphCascadeRecords.some(
			( record ) =>
				selectorHasClass( record.selector, 'topology-node' ) &&
				selectorHasClass( record.selector, className ) &&
				( 'opacity' === record.property ||
					/^--[a-z-]*opacity$/.test( record.property ) )
		)
);
const nodeStateOpacityProperties = new Set(
	graphCascadeRecords
		.filter(
			( record ) =>
				nodeOpacityStateClasses.some( ( className ) =>
					selectorHasClass( record.selector, className )
				) && /^--[a-z-]*opacity$/.test( record.property )
		)
		.map( ( record ) => record.property )
);

const replSemanticClasses = new Set();
for ( const rule of graphRules ) {
	if ( ! semanticForegroundValue( rule.declarations.color ) ) {
		continue;
	}
	for ( const selector of rule.selectors ) {
		for ( const match of selector.matchAll(
			/\.((?:topology-repl)__[\w-]+)/g
		) ) {
			replSemanticClasses.add( match[ 1 ] );
		}
	}
}

const replSurfaceClasses = new Set(
	graphCascadeRecords
		.filter(
			( record ) =>
				[ 'background', 'background-color' ].includes(
					record.property
				) && /var\(--repl-bg/.test( record.value )
		)
		.flatMap( ( record ) =>
			[ ...record.selector.matchAll( /\.(topology-repl__[\w-]+)/g ) ].map(
				( match ) => match[ 1 ]
			)
		)
);

const createTableFixture = ( slug, rowClass, hovered = false ) => {
	const dom = new JSDOM( `
		<!doctype html>
		<html class="theme-${ slug }">
			<body>
				<main class="newspack-nodes-ui newspack-nodes-skin-root newspack-nodes-theme">
					<div class="newspack-nodes-table" role="rowgroup">
						<div class="newspack-nodes-table__row ${ rowClass }" role="row"${
							hovered ? ' data-cascade-hover' : ''
						}>
							<span class="entry-status" data-status="218"></span>
							<span class="entry-status" data-status="307"></span>
							<span class="entry-status" data-status="418"></span>
							<span class="entry-status" data-status="599"></span>
							<span class="entry-status" data-status="17"></span>
						</div>
					</div>
				</main>
			</body>
		</html>
	` );
	return dom.window.document;
};

describe( 'theme skin ramps', () => {
	it( 'compiles the theme stylesheet directly from source', () => {
		expect( stylesheet.nodes.length ).toBeGreaterThan( 0 );
	} );

	it( 'preserves alpha while compositing a translucent layer', () => {
		const red = parseColor( '#ff0000' );
		const blue = parseColor( '#0000ff' );
		const transparent = parseColor( 'transparent' );
		const translucentRed = withOpacity( red, 0.25 );

		expect( composite( translucentRed, transparent ) ).toEqual( {
			r: 255,
			g: 0,
			b: 0,
			a: 0.25,
		} );
		expect( composite( translucentRed, blue ) ).toEqual( {
			r: 63.75,
			g: 0,
			b: 191.25,
			a: 1,
		} );
	} );

	it( 'mirrors production graph ancestry for detail-mode nodes', () => {
		const fixture = createGraphFixture( 'neotokyo', 'is-idle', true );

		expect(
			fixture.querySelector(
				'main.topology-app.newspack-nodes-theme.newspack-nodes-ui .topology-canvas > svg.topology-canvas-svg > g.topology-nodes.topology-nodes--bloom > g.topology-node.is-idle[data-cascade-hover]'
			)
		).not.toBeNull();
	} );

	it( 'lets an important declaration beat a later, more-specific declaration', () => {
		const records = cascadeRecords(
			postcss.parse( `
				.fixture-target {
					color: #13579b !important;
				}
				#fixture-important.fixture-target {
					color: #2468ac;
				}
			` )
		);
		const fixture = new JSDOM(
			'<div id="fixture-important" class="fixture-target"></div>'
		).window.document;
		const target = fixture.querySelector( '.fixture-target' );

		expect( winningDeclaration( records, target, 'color' ) ).toMatchObject(
			{
				important: true,
				selector: '.fixture-target',
				value: '#13579b',
			}
		);
	} );

	it( 'uses the maximum :is() branch specificity even when that branch does not match', () => {
		const records = cascadeRecords(
			postcss.parse( `
				.fixture-target:is(.active, #never-matches) {
					color: #1a2b3c;
				}
				.fixture-shell .fixture-target.active {
					color: #4d5e6f;
				}
			` )
		);
		const fixture = new JSDOM(
			'<div class="fixture-shell"><div class="fixture-target active"></div></div>'
		).window.document;
		const target = fixture.querySelector( '.fixture-target' );

		expect( winningDeclaration( records, target, 'color' ) ).toMatchObject(
			{
				selector: '.fixture-target:is(.active,#never-matches)',
				value: '#1a2b3c',
			}
		);
	} );

	it( 'includes the :not() argument when comparing specificity', () => {
		const records = cascadeRecords(
			postcss.parse( `
				.fixture-target:not(#fixture-disabled) {
					color: #713b87;
				}
				.fixture-shell .fixture-target.active {
					color: #2894a6;
				}
			` )
		);
		const fixture = new JSDOM(
			'<div class="fixture-shell"><div class="fixture-target active"></div></div>'
		).window.document;
		const target = fixture.querySelector( '.fixture-target' );

		expect( winningDeclaration( records, target, 'color' ) ).toMatchObject(
			{
				selector: '.fixture-target:not(#fixture-disabled)',
				value: '#713b87',
			}
		);
	} );

	it( 'includes the :has() argument when comparing specificity', () => {
		const records = cascadeRecords(
			postcss.parse( `
				.fixture-target:has(> #fixture-child) {
					color: #b7410e;
				}
				.fixture-shell .fixture-target.active {
					color: #2e8b57;
				}
			` )
		);
		const fixture = new JSDOM(
			'<div class="fixture-shell"><div class="fixture-target active"><span id="fixture-child"></span></div></div>'
		).window.document;
		const target = fixture.querySelector( '.fixture-target' );

		expect( winningDeclaration( records, target, 'color' ) ).toMatchObject(
			{
				selector: '.fixture-target:has(> #fixture-child)',
				value: '#b7410e',
			}
		);
	} );

	it( 'gives :where() zero specificity', () => {
		const records = cascadeRecords(
			postcss.parse( `
				.fixture-shell .fixture-target {
					color: #36454f;
				}
				.fixture-target:where(#fixture-where) {
					color: #c71585;
				}
			` )
		);
		const fixture = new JSDOM(
			'<div class="fixture-shell"><div id="fixture-where" class="fixture-target"></div></div>'
		).window.document;
		const target = fixture.querySelector( '.fixture-target' );

		expect( winningDeclaration( records, target, 'color' ) ).toMatchObject(
			{
				selector: '.fixture-shell .fixture-target',
				value: '#36454f',
			}
		);
	} );

	it( 'uses source order only after specificity ties', () => {
		const records = cascadeRecords(
			postcss.parse( `
				.fixture-target.active {
					opacity: 0.23;
				}
				.fixture-shell .fixture-target {
					opacity: 0.81;
				}
			` )
		);
		const fixture = new JSDOM(
			'<div class="fixture-shell"><div class="fixture-target active"></div></div>'
		).window.document;
		const target = fixture.querySelector( '.fixture-target' );

		expect(
			winningDeclaration( records, target, 'opacity' )
		).toMatchObject( {
			selector: '.fixture-shell .fixture-target',
			value: '0.81',
		} );
	} );

	it( 'fails loudly when a matching declaration has an unevaluated condition', () => {
		const records = cascadeRecords(
			postcss.parse( `
				.fixture-target {
					color: #102938;
				}
				@media (min-width: 1237px) {
					.fixture-target {
						color: #8a2be2;
					}
				}
			` )
		);
		const fixture = new JSDOM( '<div class="fixture-target"></div>' ).window
			.document;
		const target = fixture.querySelector( '.fixture-target' );

		expect( () => winningDeclaration( records, target, 'color' ) ).toThrow(
			/@media \(min-width: 1237px\).*\.fixture-target.*#8a2be2/
		);
	} );

	it( 'pins the browser-winning graph node hover background', () => {
		const fixture = createGraphFixture(
			'newspack-brand',
			'is-faded',
			true
		);
		const background = fixture.querySelector( '.topology-node__bg' );

		expect(
			winningDeclaration( graphCascadeRecords, background, 'fill' )
		).toMatchObject( {
			selector:
				'.theme-newspack-brand .topology-app .topology-node:hover .topology-node__bg',
			value: 'color-mix(in srgb, var(--ink) 8%, var(--paper-2))',
		} );
	} );

	it.each( [ 'row-odd', 'row-even' ] )(
		'pins the browser-winning %s table hover background',
		( rowClass ) => {
			const fixture = createTableFixture( 'nord', rowClass, true );
			const row = fixture.querySelector( '.newspack-nodes-table__row' );

			expect(
				winningDeclaration( uiCascadeRecords, row, [
					'background',
					'background-color',
				] )
			).toMatchObject( {
				selector:
					':where(.newspack-nodes-ui) .newspack-nodes-table[role=rowgroup] [role=row]:hover',
				value: 'color-mix(in srgb, var(--cyan, var(--np-primary)) 15%, var(--paper-2, var(--np-surface-subtle)))',
			} );
		}
	);

	it( 'defines exactly the registered skins on both supported skin roots', () => {
		expect( skinRules.map( ( { slug } ) => slug ) ).toEqual(
			EXPECTED_SKINS
		);
	} );

	it( 'iterates the skin map without a parallel slug registry', () => {
		expect( skinsSource ).not.toMatch( /\$skin-slugs\s*:/ );
		expect( skinsSource ).toMatch(
			/@each\s+\$slug\s*,\s*\$tokens\s+in\s+\$skins\s*\{/
		);
	} );

	it( 'owns the exact common derived-token contract', () => {
		expect( commonRules ).toEqual( [ COMMON_DERIVED_TOKENS ] );
		expect(
			Object.fromEntries(
				skinRules
					.map( ( { slug, tokens } ) => [
						slug,
						Object.fromEntries(
							Object.keys( COMMON_DERIVED_TOKENS )
								.filter(
									( token ) =>
										! CONTRAST_FOREGROUND_TOKENS.has(
											token
										) && undefined !== tokens[ token ]
								)
								.map( ( token ) => [ token, tokens[ token ] ] )
						),
					] )
					.filter(
						( [ , tokens ] ) => 0 < Object.keys( tokens ).length
					)
			)
		).toEqual( ALLOWED_DERIVED_OVERRIDES );
	} );

	it( 'keeps standalone, product-skin, and decorative modal depth independent', () => {
		expect( themeTokens[ '--np-modal-radius' ] ).toBe(
			'var(--np-radius-md)'
		);
		expect( compactWhitespace( themeTokens[ '--np-modal-shadow' ] ) ).toBe(
			STOCK_MODAL_SHADOW
		);

		for ( const slug of [ 'newspack', 'newspack-brand' ] ) {
			expect( effectiveSkin( slug ) ).toMatchObject( {
				'--button-radius': '5px',
				'--field-radius': '0',
				'--modal-radius': '6px',
				'--modal-shadow': NEWSPACK_MODAL_SHADOW,
			} );
		}

		expect( effectiveSkin( 'current' ) ).toMatchObject( {
			'--modal-radius': '5px',
			'--modal-shadow': 'none',
		} );
	} );

	it( 'pins Newspack status neutrals and their contrast on both paper surfaces', () => {
		const expectedStatusTokens = {
			'--status-text': {
				color: '#666',
				minimumContrast: 5.36,
			},
			'--muted-text': {
				color: '#717171',
				minimumContrast: 4.55,
			},
		};

		for ( const slug of [ 'newspack', 'newspack-brand' ] ) {
			const skin = effectiveSkin( slug );
			const papers = paperColors( slug, skin ).slice( 0, 2 );
			for ( const [ role, expected ] of Object.entries(
				expectedStatusTokens
			) ) {
				const color = resolvedColor( skin, role );
				expect( color ).toEqual( parseColor( expected.color ) );
				expect(
					Number(
						Math.min(
							...papers.map( ( paper ) =>
								contrast( color, paper )
							)
						).toFixed( 2 )
					)
				).toBeGreaterThanOrEqual( expected.minimumContrast );
			}
		}
	} );

	it( 'draws one eight-slot Newspack chart palette in both Newspack skins', () => {
		const expected = [
			'#406ebc',
			'#178e53',
			'#bd8600',
			'#d63638',
			'#809ed2',
			'#c5788b',
			'#dc8c00',
			'#1fb36a',
		];
		for ( const slug of [ 'newspack', 'newspack-brand' ] ) {
			const skin = effectiveSkin( slug );
			const paper = resolvedColor( skin, '--paper-2' );
			expect( paper ).toEqual( parseColor( '#f7f7f7' ) );
			expected.forEach( ( hex, index ) => {
				const role = `--chart-${ index + 1 }`;
				const color = resolvedColor( skin, role );
				expect( [ slug, role, color ] ).toEqual( [
					slug,
					role,
					parseColor( hex ),
				] );
				expect( contrast( color, paper ) ).toBeGreaterThanOrEqual(
					2.5
				);
			} );
		}
	} );

	it( 'resolves the legacy focus ring to --np-text where no skin sets --ink', () => {
		let outline = null;
		stylesheet.walkRules( ( rule ) => {
			if ( /:focus-visible/.test( rule.selector ) ) {
				outline = allDeclarations( rule ).outline ?? outline;
			}
		} );
		expect( outline ).not.toBeNull();
		const ring = /^2px solid (.+)$/.exec( outline )?.[ 1 ];
		expect( resolveCssColor( ring, {} ) ).toEqual(
			parseColor( themeTokens[ '--np-text' ] )
		);
	} );

	it( 'draws the Cobalt scale chip, as many steps as Admin::SCALE_CHIP_STEPS, with ink at 4.5:1 or more, ΔE of 8 or more between steps, and falling lightness', () => {
		const chipRules = stylesheet.nodes.filter(
			( node ) =>
				'rule' === node.type &&
				/^\.newspack-nodes-theme\.np-scale-chip--\d+$/.test(
					normalizeSelector( node.selector )
				)
		);
		const phpSteps = Number(
			/const SCALE_CHIP_STEPS\s*=\s*(\d+);/.exec(
				fs.readFileSync(
					path.join( ROOT, 'includes/admin/class-admin.php' ),
					'utf8'
				)
			)?.[ 1 ]
		);
		expect( chipRules.length ).toBe( phpSteps );
		const steps = chipRules.map( ( rule, index ) => {
			expect( normalizeSelector( rule.selector ) ).toBe(
				`.newspack-nodes-theme.np-scale-chip--${ index + 1 }`
			);
			const declared = allDeclarations( rule );
			expect( resolveCssColor( declared.color, {} ) ).toEqual(
				parseColor( themeTokens[ '--np-text' ] )
			);
			return resolveCssColor( declared.background, {} );
		} );
		const ink = parseColor( themeTokens[ '--np-text' ] );
		const lab = ( { r, g, b } ) => {
			const [ x, y, z ] = [
				[ 0.4124, 0.3576, 0.1805 ],
				[ 0.2126, 0.7152, 0.0722 ],
				[ 0.0193, 0.1192, 0.9505 ],
			].map(
				( row, index ) =>
					( row[ 0 ] * linear( r ) +
						row[ 1 ] * linear( g ) +
						row[ 2 ] * linear( b ) ) /
					[ 0.95047, 1, 1.08883 ][ index ]
			);
			const f = ( t ) =>
				0.008856 < t ? Math.cbrt( t ) : 7.787 * t + 16 / 116;
			return [
				116 * f( y ) - 16,
				500 * ( f( x ) - f( y ) ),
				200 * ( f( y ) - f( z ) ),
			];
		};
		const labs = steps.map( lab );
		const pairs = labs
			.slice( 1 )
			.map( ( next, index ) => [ labs[ index ], next ] );
		steps.forEach( ( step ) =>
			expect( contrast( ink, step ) ).toBeGreaterThanOrEqual( 4.5 )
		);
		pairs.forEach( ( [ lighter, darker ] ) => {
			expect( darker[ 0 ] ).toBeLessThan( lighter[ 0 ] );
			expect(
				Math.hypot( ...darker.map( ( v, i ) => v - lighter[ i ] ) )
			).toBeGreaterThanOrEqual( 8 );
		} );
	} );

	it( 'never reads a chart token from a text color declaration', () => {
		const offenders = productionRules
			.filter( ( rule ) =>
				/--(?:np-)?chart-/.test( rule.declarations.color || '' )
			)
			.map(
				( rule ) => `${ rule.selector }: ${ rule.declarations.color }`
			);
		expect( offenders ).toEqual( [] );
	} );

	it( 'preserves distinct contrast-safe semantic colors in both Newspack skins', () => {
		expect(
			Object.fromEntries(
				[ 'newspack', 'newspack-brand' ].map( ( slug ) => [
					slug,
					Object.fromEntries(
						Object.keys(
							EXPECTED_SEMANTIC_TEXT_OVERRIDES[ slug ]
						).map( ( token ) => [
							token,
							skinMaps.get( slug )?.[ token ],
						] )
					),
				] )
			)
		).toEqual( EXPECTED_SEMANTIC_TEXT_OVERRIDES );
	} );

	it( 'keeps the secondary role off every role class by selector rather than source order', () => {
		// Every role paints at (0,4,0), and a marked reset toggle carries
		// `button-secondary` AND `is-danger`, so only the exclusion decides.
		const secondary = productionRule(
			( selector ) =>
				selector.includes( '.button:not(' ) &&
				! selector.includes( ':hover' )
		);
		for ( const role of [ '.is-danger', '.is-active', '.is-paused' ] ) {
			expect( secondary.selector ).toContain( role );
		}
	} );

	it( 'binds every canonical action and semantic status to its real foreground token', () => {
		const primary = productionRule(
			( selector ) =>
				selector.includes( '.button.button-primary' ) &&
				! selector.includes( ':hover' ) &&
				! selector.includes( ':disabled' )
		);
		const primaryHover = productionRule( ( selector ) =>
			selector.includes( '.button.button-primary:hover' )
		);
		const danger = productionRule(
			( selector ) =>
				selector.includes( '.button.is-danger' ) &&
				! selector.includes( ':hover' ) &&
				! selector.includes( ':disabled' )
		);
		const dangerHover = productionRule( ( selector ) =>
			selector.includes( '.button.is-danger:hover' )
		);
		const paused = productionRule(
			( selector ) =>
				selector.includes( '.button.is-paused' ) &&
				! selector.includes( ':hover' )
		);
		const pausedHover = productionRule( ( selector ) =>
			selector.includes( '.button.is-paused:hover' )
		);
		const active = productionRule(
			( selector ) =>
				selector.includes( '.button.is-active' ) &&
				! selector.includes( ':hover' )
		);
		const activeHover = productionRule( ( selector ) =>
			selector.includes( '.button.is-active:hover' )
		);
		const modalCloseHover = productionRule( ( selector ) =>
			selector.includes( '.newspack-nodes-modal__close:hover' )
		);
		const topologySave = productionRule(
			( selector ) =>
				selector.includes( '.topology-mode__btn--save' ) &&
				! selector.includes( ':hover' )
		);
		const errorBanner = productionRule( ( selector ) =>
			selector.endsWith( ' .newspack-nodes-error-banner' )
		);
		const successStatus = productionRule( ( selector ) =>
			selector.endsWith( ' .newspack-nodes-status.is-success' )
		);
		const errorStatus = productionRule( ( selector ) =>
			selector.endsWith( ' .newspack-nodes-status.is-error' )
		);

		const actualActionPairs = [
			[ primary, '--cyan', '--on-cyan' ],
			[ primaryHover, '--cyan-dark', '--on-cyan-dark' ],
			[ danger, '--oxide', '--on-oxide' ],
			[ dangerHover, '--oxide-dark', '--on-oxide-dark' ],
			[ paused, '--brass', '--on-brass' ],
			[ pausedHover, '--brass-dark', '--on-brass-dark' ],
			[ active, '--cyan', '--on-cyan' ],
			[ activeHover, '--cyan-dark', '--on-cyan-dark' ],
			[ modalCloseHover, '--oxide', '--on-oxide' ],
			[ topologySave, '--sage', '--on-sage' ],
			[ errorBanner, '--oxide', '--on-oxide' ],
		].map( ( [ rule, background, foreground ] ) => ( {
			background: firstVarToken( rule?.declarations.background ),
			color: firstVarToken( rule?.declarations.color ),
			expectedBackground: background,
			expectedColor: foreground,
		} ) );
		expect( actualActionPairs ).toEqual(
			actualActionPairs.map( ( pair ) => ( {
				...pair,
				background: pair.expectedBackground,
				color: pair.expectedColor,
			} ) )
		);
		expect( {
			success: firstVarToken( successStatus?.declarations.color ),
			error: firstVarToken( errorStatus?.declarations.color ),
		} ).toEqual( {
			success: '--sage-text',
			error: '--oxide-text',
		} );
	} );

	it( 'meets WCAG AA for every canonical action foreground/background pair', () => {
		const pairings = [
			[ '--on-cyan', '--cyan' ],
			[ '--on-cyan-dark', '--cyan-dark' ],
			[ '--on-oxide', '--oxide' ],
			[ '--on-oxide-dark', '--oxide-dark' ],
			[ '--on-brass', '--brass' ],
			[ '--on-brass-dark', '--brass-dark' ],
			[ '--on-sage', '--sage' ],
		];
		const failures = [];

		for ( const slug of EXPECTED_SKINS ) {
			const skin = effectiveSkin( slug );
			for ( const [ foregroundRole, backgroundRole ] of pairings ) {
				const foreground = resolvedColor( skin, foregroundRole );
				const background = resolvedColor( skin, backgroundRole );
				if ( ! foreground || ! background ) {
					failures.push(
						`${ slug }:${ foregroundRole } on ${ backgroundRole }:unresolved`
					);
					continue;
				}
				const ratio = foregroundContrast(
					slug,
					foreground,
					background
				);
				if ( MINIMUM_TEXT_CONTRAST > ratio ) {
					failures.push(
						`${ slug }:${ foregroundRole } on ${ backgroundRole }:${ ratio.toFixed(
							2
						) }`
					);
				}
			}
		}

		expect( failures ).toEqual( [] );
	} );

	it( 'keeps canonical semantic foreground roles AA-readable on canonical paper roles', () => {
		const foregroundRoles = [
			'--cyan-text',
			'--brass-text',
			'--sage-text',
			'--oxide-text',
		];
		const failures = [];
		for ( const slug of EXPECTED_SKINS ) {
			const skin = effectiveSkin( slug );
			const papers = paperColors( slug, skin );
			for ( const foregroundRole of foregroundRoles ) {
				const foreground = resolvedColor( skin, foregroundRole );
				for ( let index = 0; index < papers.length; index++ ) {
					const ratio = contrast( foreground, papers[ index ] );
					if ( MINIMUM_TEXT_CONTRAST > ratio ) {
						failures.push(
							`${ slug }:${ foregroundRole } on ${
								PAPER_ROLES[ index ]
							}:${ ratio.toFixed( 2 ) }`
						);
					}
				}
			}
		}
		expect( failures ).toEqual( [] );
	} );

	it( 'keeps muted status text quieter than base status and AA-readable on both status surfaces', () => {
		const baseStatus = productionRule( ( selector ) =>
			selector.endsWith( ' .newspack-nodes-status' )
		);
		const mutedStatus = productionRule( ( selector ) =>
			selector.endsWith( ' .newspack-nodes-status.is-muted' )
		);
		expect( {
			base: firstVarToken( baseStatus?.declarations.color ),
			muted: firstVarToken( mutedStatus?.declarations.color ),
		} ).toEqual( {
			base: '--status-text',
			muted: '--muted-text',
		} );

		const failures = [];
		for ( const slug of EXPECTED_SKINS ) {
			const skin = effectiveSkin( slug );
			const base = resolvedColor( skin, '--status-text' );
			const muted = resolvedColor( skin, '--muted-text' );
			const papers = paperColors( slug, skin ).slice( 0, 2 );
			for ( let index = 0; index < papers.length; index++ ) {
				const baseRatio = contrast( base, papers[ index ] );
				const mutedRatio = contrast( muted, papers[ index ] );
				if (
					MINIMUM_TEXT_CONTRAST > mutedRatio ||
					baseRatio <= mutedRatio
				) {
					failures.push(
						`${ slug }:--muted-text on ${
							PAPER_ROLES[ index ]
						}:${ mutedRatio.toFixed(
							2
						) } (base ${ baseRatio.toFixed( 2 ) })`
					);
				}
			}
		}
		expect( failures ).toEqual( [] );
	} );

	it( 'keeps actual same-rule semantic foreground/surface pairs AA-readable', () => {
		expect( [ ...productionSemanticForegrounds ] ).toEqual(
			expect.arrayContaining( [
				'var(--cyan-text, var(--np-text))',
				'var(--brass-text, var(--np-text))',
				'var(--sage-text, var(--np-text))',
				'var(--oxide-text, var(--np-text))',
			] )
		);
		expect( productionSemanticSurfacePairs.length ).toBeGreaterThan( 0 );
		const failures = [];
		for ( const slug of EXPECTED_SKINS ) {
			const skin = effectiveSkin( slug );
			for ( const {
				foreground: foregroundValue,
				selector,
				surface: surfaceValue,
			} of productionSemanticSurfacePairs ) {
				const foreground = resolveCssColor( foregroundValue, skin );
				if ( ! foreground ) {
					failures.push(
						`${ slug }:${ foregroundValue }:unresolved foreground`
					);
					continue;
				}
				const background = effectiveSurfaceColor( surfaceValue, skin );
				if ( ! background ) {
					failures.push(
						`${ slug }:${ selector }:${ surfaceValue }:unresolved background`
					);
					continue;
				}
				const ratio = contrast(
					1 === foreground.a
						? foreground
						: composite( foreground, background ),
					background
				);
				if ( MINIMUM_TEXT_CONTRAST > ratio ) {
					failures.push(
						`${ slug }:${ foregroundValue } on ${ selector } (${ surfaceValue }):${ ratio.toFixed(
							2
						) }`
					);
				}
			}
		}

		expect( [ ...new Set( failures ) ] ).toEqual( [] );
	} );

	it( 'keeps the duplicate JavaScript status-text API absent', () => {
		const formatUtilsSource = fs.readFileSync( FORMAT_UTILS_JS, 'utf8' );
		expect( formatUtilsSource ).not.toMatch( /\bSTATUS_TEXT_COLORS\b/ );
		expect( formatUtilsSource ).not.toMatch( /\bgetStatusTextColor\b/ );
	} );

	it( 'keeps canonical CSS status roles readable on actual table ancestry and row states', () => {
		const rowStates = [
			{ className: 'row-odd', hovered: false },
			{ className: 'row-even', hovered: false },
			{ className: 'row-odd', hovered: true },
			{ className: 'row-even', hovered: true },
		];
		const failures = [];
		const inheritedColor = ( element ) => {
			let current = element;
			while ( current ) {
				const value = winningDeclaration(
					uiCascadeRecords,
					current,
					'color'
				)?.value;
				if ( value ) {
					return value;
				}
				current = current.parentElement;
			}
			return undefined;
		};

		for ( const slug of EXPECTED_SKINS ) {
			const skin = effectiveSkin( slug );
			for ( const { className, hovered } of rowStates ) {
				const fixture = createTableFixture( slug, className, hovered );
				const table = fixture.querySelector( '.newspack-nodes-table' );
				const row = fixture.querySelector(
					'.newspack-nodes-table__row'
				);
				const tableValue = winningDeclaration(
					uiCascadeRecords,
					table,
					[ 'background', 'background-color' ]
				)?.value;
				const rowValue = winningDeclaration( uiCascadeRecords, row, [
					'background',
					'background-color',
				] )?.value;
				const tableBackground = effectiveSurfaceColor(
					tableValue,
					skin
				);
				const background = effectiveSurfaceColor(
					rowValue,
					skin,
					tableBackground
				);
				if ( ! tableValue || ! rowValue || ! background ) {
					failures.push(
						`${ slug }:${ className }:${
							hovered ? 'hover' : 'rest'
						}:unresolved ancestry`
					);
					continue;
				}
				const foregroundValues = new Set(
					[ ...fixture.querySelectorAll( '.entry-status' ) ].map(
						inheritedColor
					)
				);
				expect( foregroundValues ).toEqual(
					new Set( [
						'var(--sage-text, var(--np-text))',
						'var(--brass-text, var(--np-text))',
						'var(--oxide-text, var(--np-text))',
						'var(--ink, var(--np-text))',
					] )
				);
				for ( const foregroundValue of foregroundValues ) {
					const foreground = resolveCssColor( foregroundValue, skin );
					if ( ! foreground ) {
						failures.push(
							`${ slug }:unresolved ${ foregroundValue }`
						);
						continue;
					}
					const ratio = contrast(
						1 === foreground.a
							? foreground
							: composite( foreground, background ),
						background
					);
					if ( MINIMUM_TEXT_CONTRAST > ratio ) {
						failures.push(
							`${ slug }:${ foregroundValue } on ${ className } ${
								hovered ? 'hover' : 'rest'
							}:${ ratio.toFixed( 2 ) }`
						);
					}
				}
			}
		}

		expect( failures ).toEqual( [] );
	} );

	it( 'keeps every browser-winning SVG text fill opaque and readable through node states', () => {
		expect( schematicSemanticTextRecords.length ).toBeGreaterThan( 0 );
		expect( schematicHeaderHeight ).toBeGreaterThan( 0 );
		expect( [ ...nodeOpacityStateClasses ].sort() ).toEqual( [
			'is-dragging',
			'is-faded',
			'is-idle',
		] );
		const failures = [];
		if ( 1 !== nodeStateOpacityProperties.size ) {
			failures.push(
				`node state opacity properties:${
					[ ...nodeStateOpacityProperties ].join( ',' ) || 'none'
				}`
			);
		}
		const stateOpacityProperty = [ ...nodeStateOpacityProperties ][ 0 ];
		// An idle card dims text and all, so it holds no text to this bar.
		const stateOpacities = {
			'is-dragging': 0.9,
			'is-faded': 0.4,
		};
		const fixture = createGraphFixture( 'current' );
		const fixtureTextRecords = [
			...fixture.querySelectorAll(
				'.topology-node text, .topology-node-readout text'
			),
		].map( ( element ) => ( {
			className: element.getAttribute( 'class' ),
			y: Number( element.getAttribute( 'y' ) ),
		} ) );
		expect( fixtureTextRecords ).toEqual( schematicTextRecords );
		const productionGraphics = [
			...new Map(
				schematicNodeGraphicRecords.map( ( record ) => [
					`${ record.tag }:${ record.className }`,
					record,
				] )
			).values(),
		];
		const fixtureGraphics = [
			...fixture.querySelectorAll(
				'.topology-node rect, .topology-node line, .topology-node circle, .topology-node path, .topology-node-readout path'
			),
		].map( ( element ) => ( {
			className: element
				.getAttribute( 'class' )
				.split( /\s+/ )
				.find(
					( className ) =>
						className.startsWith( 'topology-node__' ) ||
						'topology-port' === className
				),
			tag: element.tagName.toLowerCase(),
		} ) );
		expect( fixtureGraphics ).toEqual( schematicNodeGraphicRecords );

		for ( const slug of EXPECTED_SKINS ) {
			const skin = effectiveSkin( slug );
			const canvas = effectiveSurfaceColor( 'var(--canvas)', skin );
			for ( const [ stateClass, stateOpacity ] of Object.entries(
				stateOpacities
			) ) {
				for ( const hovered of [ false, true ] ) {
					const stateFixture = createGraphFixture(
						slug,
						stateClass,
						hovered
					);
					const node = stateFixture.querySelector( '.topology-node' );
					const nodeBackground =
						stateFixture.querySelector( '.topology-node__bg' );
					const nodeHeader = stateFixture.querySelector(
						'.topology-node__header'
					);
					const rootOpacity = elementOpacity( node );
					const backgroundOpacity = elementOpacity( nodeBackground );
					const headerOpacity = elementOpacity( nodeHeader );
					if (
						1 !== rootOpacity ||
						stateOpacity !== backgroundOpacity ||
						stateOpacity !== headerOpacity
					) {
						failures.push(
							`${ slug }:${ stateClass }:${
								hovered ? 'hover' : 'rest'
							}:opacity root=${ rootOpacity } bg=${ backgroundOpacity } header=${ headerOpacity }`
						);
					}
					if ( stateOpacityProperty ) {
						for ( const { className } of productionGraphics ) {
							const graphic = stateFixture.querySelector(
								`.${ className }`
							);
							const opacityValue = graphValue(
								graphic,
								'opacity'
							);
							if (
								! opacityValue?.includes(
									`var(${ stateOpacityProperty })`
								)
							) {
								failures.push(
									`${ slug }:${ stateClass }:${ className }:${
										opacityValue ?? 'missing state opacity'
									}`
								);
							}
						}
					}
					const backgroundValue = graphValue(
						nodeBackground,
						'fill'
					);
					const headerValue = graphValue( nodeHeader, 'fill' );
					const backgroundColor = resolveCssColor(
						backgroundValue,
						skin
					);
					const headerColor =
						'none' === headerValue
							? parseColor( 'transparent' )
							: resolveCssColor( headerValue, skin );
					if (
						! canvas ||
						! backgroundColor ||
						! headerColor ||
						null === rootOpacity ||
						null === backgroundOpacity ||
						null === headerOpacity
					) {
						failures.push(
							`${ slug }:${ stateClass }:${
								hovered ? 'hover' : 'rest'
							}:unresolved node surface`
						);
						continue;
					}
					const renderedBody = composite(
						withOpacity( backgroundColor, backgroundOpacity ),
						canvas
					);
					const renderedHeader =
						'none' === headerValue
							? renderedBody
							: composite(
									withOpacity( headerColor, headerOpacity ),
									renderedBody
							  );

					for ( const { className, y } of schematicTextRecords ) {
						const text = stateFixture.querySelector(
							`.${ className }`
						);
						const foregroundValue = graphValue( text, 'fill' );
						const foreground = resolveCssColor(
							foregroundValue,
							skin
						);
						const textOpacity = elementOpacity( text );
						if (
							! foreground ||
							1 !== foreground.a ||
							1 !== textOpacity
						) {
							failures.push(
								`${ slug }:${ stateClass }:${ className }:fill=${ foregroundValue } fill-alpha=${ foreground?.a } opacity=${ textOpacity }`
							);
							continue;
						}
						const renderedSurface =
							null !== y && y <= schematicHeaderHeight
								? renderedHeader
								: renderedBody;
						const ratio = contrast( foreground, renderedSurface );
						if ( MINIMUM_TEXT_CONTRAST > ratio ) {
							failures.push(
								`${ slug }:${ stateClass }:${
									hovered ? 'hover' : 'rest'
								}:${ className }:${ foregroundValue }:${ ratio.toFixed(
									2
								) }`
							);
						}
					}
				}
			}
		}

		expect( [ ...new Set( failures ) ] ).toEqual( [] );
	} );

	it( 'draws an idle card and its readout, frame and text, at reduced ink, switching at once', () => {
		const effectiveOpacity = ( element ) => {
			let opacity = 1;
			for ( let at = element; at; at = at.parentElement ) {
				opacity *= elementOpacity( at );
			}
			return opacity;
		};
		const parts = [
			'.topology-node__bg',
			'.topology-node__header',
			'.topology-port',
			'.topology-node__type',
			'.topology-node__id',
			'.topology-node__spark',
			'.topology-node__rate',
			'.topology-node__counter',
		];
		const failures = [];
		for ( const slug of EXPECTED_SKINS ) {
			const idle = createGraphFixture( slug, 'is-idle' );
			const busy = createGraphFixture( slug );
			for ( const part of parts ) {
				const dimmed = effectiveOpacity( idle.querySelector( part ) );
				const full = effectiveOpacity( busy.querySelector( part ) );
				if ( 0.55 !== dimmed || 1 !== full ) {
					failures.push(
						`${ slug }:${ part }:idle=${ dimmed } busy=${ full }`
					);
				}
			}
			for ( const root of [
				'.topology-node',
				'.topology-node-readout',
			] ) {
				const transition = graphValue(
					idle.querySelector( root ),
					'transition'
				);
				if ( undefined !== transition && 'none' !== transition ) {
					failures.push( `${ slug }:${ root }:eases its dim` );
				}
			}
		}

		expect( failures ).toEqual( [] );
	} );

	it( 'never restarts the entrance fade when a card leaves idle or faded', () => {
		const failures = [];
		for ( const root of [ '.topology-node', '.topology-node-readout' ] ) {
			const entrance = graphValue(
				createGraphFixture( 'current' ).querySelector( root ),
				'animation'
			);
			// A finished `backwards` fade holds nothing, so a dim shows through.
			if ( ! /\bbackwards\b/.test( entrance || '' ) ) {
				failures.push( `${ root }:fill=${ entrance }` );
			}
			// An override that comes off re-runs the fade from opacity 0.
			for ( const state of [ 'is-idle', 'is-faded' ] ) {
				const animation = graphValue(
					createGraphFixture( 'current', state ).querySelector(
						root
					),
					'animation'
				);
				if ( animation !== entrance ) {
					failures.push( `${ root }.${ state }:${ animation }` );
				}
			}
		}

		expect( failures ).toEqual( [] );
	} );

	it( 'ends the entrance fade at the card’s own opacity, so an idle card never pops', () => {
		const ends = [];
		graphStylesheet.walkAtRules( /keyframes$/, ( atRule ) => {
			if ( 'topology-fadein' !== atRule.params ) {
				return;
			}
			atRule.walkRules( ( frame ) => {
				const stops = frame.selector
					.split( ',' )
					.map( ( s ) => s.trim() );
				if ( ! stops.some( ( s ) => 'to' === s || '100%' === s ) ) {
					return;
				}
				frame.walkDecls( 'opacity', ( decl ) => {
					ends.push( `${ frame.selector }{opacity:${ decl.value }}` );
				} );
			} );
		} );

		expect( ends ).toEqual( [] );
	} );

	it( 'keeps a dimmed wire on its undimmed animation, so un-dim never redraws it', () => {
		const edgeFixture = ( group, modifiers ) =>
			new JSDOM( `
				<!doctype html>
				<html class="theme-current">
					<body>
						<main class="topology-app newspack-nodes-theme newspack-nodes-ui">
							<section class="topology-canvas">
								<svg class="topology-canvas-svg">
									<g class="topology-edges ${ group }">
										<path class="topology-edge topology-edge--active ${ modifiers }"></path>
									</g>
								</svg>
							</section>
						</main>
					</body>
				</html>
			` ).window.document.querySelector( '.topology-edge' );
		const groups = [
			'topology-edges--bloom',
			'topology-edges--flow',
			'topology-edges--bloom topology-edges--still',
		];
		const wires = [
			'',
			'topology-edge--flowing',
			'is-virtual',
			'is-registration',
			'is-selected',
		];
		const failures = [];
		for ( const group of groups ) {
			for ( const wire of wires ) {
				const lit = graphValue(
					edgeFixture( group, wire ),
					'animation'
				);
				const dimmed = graphValue(
					edgeFixture( group, `${ wire } is-dimmed` ),
					'animation'
				);
				if ( dimmed !== lit ) {
					failures.push(
						`${ group } ${ wire }:${ lit } → ${ dimmed }`
					);
				}
			}
		}

		expect( failures ).toEqual( [] );
	} );

	it( 'lets the higher-specificity Newspack REPL overrides beat later generic rules', () => {
		expect(
			effectiveGraphDeclaration(
				'newspack',
				'topology-repl__prompt',
				'color'
			)
		).toBe( 'color-mix(in srgb, var(--cyan) 30%, var(--repl-fg))' );
		expect(
			effectiveGraphDeclaration(
				'newspack',
				'topology-repl__entry--sent',
				'color'
			)
		).toBe( 'color-mix(in srgb, var(--cyan) 30%, var(--repl-fg))' );
		expect(
			effectiveGraphDeclaration(
				'newspack-brand',
				'topology-repl__prompt',
				'color'
			)
		).toBe( 'color-mix(in srgb, var(--sage) 30%, var(--repl-fg))' );
		expect(
			effectiveGraphDeclaration(
				'newspack-brand',
				'topology-repl__entry--sent',
				'color'
			)
		).toBe( 'color-mix(in srgb, var(--sage) 30%, var(--repl-fg))' );
	} );

	it( 'composites every production REPL semantic foreground over its translucent surface', () => {
		expect( [ ...replSemanticClasses ].sort() ).toEqual( [
			'topology-repl__entry--error',
			'topology-repl__entry--sent',
			'topology-repl__prompt',
		] );
		expect( [ ...replSurfaceClasses ].sort() ).toEqual( [
			'topology-repl__bar',
			'topology-repl__transcript',
		] );
		const failures = [];

		for ( const slug of EXPECTED_SKINS ) {
			const skin = effectiveSkin( slug );
			const fixture = createGraphFixture( slug );
			for ( const className of replSemanticClasses ) {
				const element = fixture.querySelector( `.${ className }` );
				const foregroundValue = graphValue( element, 'color' );
				const foreground = resolveCssColor( foregroundValue, skin );
				const surface = element.closest(
					'.topology-repl__bar, .topology-repl__transcript'
				);
				const surfaceValue = winningDeclaration(
					graphCascadeRecords,
					surface,
					[ 'background', 'background-color' ]
				)?.value;
				const transcript = surface.classList.contains(
					'topology-repl__transcript'
				);
				const underlayValue = transcript
					? 'var(--canvas)'
					: 'var(--paper-3)';
				const underlay = effectiveSurfaceColor( underlayValue, skin );
				const background = effectiveSurfaceColor(
					surfaceValue,
					skin,
					underlay
				);
				if (
					! foreground ||
					! surfaceValue ||
					! underlay ||
					! background
				) {
					failures.push(
						`${ slug }:${ className }:unresolved ${ foregroundValue } on ${ surfaceValue } over ${ underlayValue }`
					);
					continue;
				}
				const ratio = contrast(
					1 === foreground.a
						? foreground
						: composite( foreground, background ),
					background
				);
				if ( MINIMUM_TEXT_CONTRAST > ratio ) {
					failures.push(
						`${ slug }:${ className }:${ foregroundValue } on ${ surfaceValue } over ${ underlayValue }:${ ratio.toFixed(
							2
						) }`
					);
				}
			}
		}
		expect( [ ...new Set( failures ) ] ).toEqual( [] );
	} );

	it( 'contains no one-size on-accent foreground', () => {
		expect( skinsSource ).not.toContain( '--on-accent' );
		expect( sass.compile( UI_SCSS ).css ).not.toContain( '--on-accent' );
	} );

	it( 'keeps non-Newspack contrast overrides limited to failed defaults', () => {
		const unnecessary = [];
		for ( const slug of EXPECTED_SKINS ) {
			const declaredSkin = skinMaps.get( slug );
			const skin = effectiveSkin( slug );
			for ( const token of CONTRAST_FOREGROUND_TOKENS ) {
				if ( undefined === declaredSkin?.[ token ] ) {
					continue;
				}
				if (
					EXPECTED_SEMANTIC_TEXT_OVERRIDES[ slug ]?.[ token ] ===
					declaredSkin[ token ]
				) {
					continue;
				}
				const defaultSkin = {
					...skin,
					[ token ]: COMMON_DERIVED_TOKENS[ token ],
				};
				const backgrounds = token.startsWith( '--on-' )
					? [
							resolvedColor(
								defaultSkin,
								`--${ token.slice( 5 ) }`
							),
					  ]
					: paperColors( slug, defaultSkin );
				const foreground = resolvedColor( defaultSkin, token );
				if (
					foreground &&
					backgrounds.every(
						( background ) =>
							background &&
							MINIMUM_TEXT_CONTRAST <=
								foregroundContrast(
									slug,
									foreground,
									background
								)
					)
				) {
					unnecessary.push( `${ slug }:${ token }` );
				}
			}
		}
		expect( unnecessary ).toEqual( [] );
	} );

	it( 'keeps the bare theme root limited to product tokens', () => {
		expect( bareThemeRules ).toHaveLength( 1 );
		expect( Object.keys( bareThemeRules[ 0 ] ).length ).toBeGreaterThan(
			0
		);
		expect(
			Object.keys( bareThemeRules[ 0 ] ).filter(
				( property ) => ! property.startsWith( '--np-' )
			)
		).toEqual( [] );
	} );

	describe.each( EXPECTED_SKINS )( '%s', ( slug ) => {
		const skin = skinMaps.get( slug );
		const requiredSkin = () => {
			expect( skin ).toBeDefined();
			return skin;
		};

		/**
		 * The colour WordPress plus the UI sheet paint on an element, with the
		 * `--wp-components-*` tokens the skin root sets resolved in the skin.
		 *
		 * @param {Element} root     The `.newspack-nodes-ui` root.
		 * @param {Element} element  The element painted.
		 * @param {string}  property The colour property read.
		 * @return {string} The painted colour's key.
		 */
		const wordpressPaint = ( root, element, property ) => {
			const tokens = { ...effectiveSkin( slug ) };
			for ( const record of wordpressUiCascadeRecords ) {
				if ( record.property.startsWith( '--wp-components-' ) ) {
					tokens[ record.property ] = winningDeclaration(
						wordpressUiCascadeRecords,
						root,
						record.property
					)?.value;
				}
			}
			const painted = winningDeclaration(
				wordpressUiCascadeRecords,
				element,
				property
			).value;
			return colorKey( resolveCssColor( painted, tokens ) );
		};

		it.each( [
			[ 'button', 'components-button', 'color', '--ink' ],
			[ 'button', 'components-button is-pressed', 'color', '--paper' ],
			[ 'button', 'components-button is-pressed', 'background', '--ink' ],
			[ 'div', 'components-calendar', 'background-color', '--paper' ],
		] )(
			"paints a WordPress <%s class=%s>'s %s in the skin's %s",
			( tag, className, property, role ) => {
				const { document } = new JSDOM(
					`<!doctype html><html class="theme-${ slug }"><body><div class="newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui"><${ tag } class="${ className }"></${ tag }></div></body></html>`
				).window;
				const root = document.querySelector( '.newspack-nodes-ui' );

				expect(
					wordpressPaint( root, root.firstElementChild, property )
				).toBe(
					colorKey( resolvedColor( effectiveSkin( slug ), role ) )
				);
			}
		);

		it.each( [
			[ 'at rest', '' ],
			[ 'hovered', ' data-cascade-hover' ],
		] )( "inks a WordPress modal's close button %s", ( state, hover ) => {
			const { document } = new JSDOM(
				`<!doctype html><html class="theme-${ slug }"><body><div class="components-modal__frame newspack-nodes-modal newspack-nodes-theme newspack-nodes-ui"><div class="components-modal__content"><div class="components-modal__header"><button class="components-button has-icon is-compact"${ hover }></button></div></div></div></body></html>`
			).window;

			expect(
				wordpressPaint(
					document.querySelector( '.newspack-nodes-ui' ),
					document.querySelector( '.components-button' ),
					'color'
				)
			).toBe(
				colorKey( resolvedColor( effectiveSkin( slug ), '--ink' ) )
			);
		} );

		it( 'defines the full base-token contract', () => {
			const tokens = requiredSkin();
			expect(
				REQUIRED_SKIN_ROLES.filter( ( role ) => ! tokens[ role ] )
			).toEqual( [] );
		} );

		it( 'defines three distinct paper roles', () => {
			const tokens = requiredSkin();
			expect(
				PAPER_ROLES.filter( ( role ) => ! tokens[ role ] )
			).toEqual( [] );
			const papers = paperColors( slug, tokens );
			expect( new Set( papers.map( colorKey ) ).size ).toBe( 3 );
		} );

		it( 'paints every surface role opaque', () => {
			const tokens = requiredSkin();
			const translucent = OPAQUE_SURFACE_ROLES.filter( ( role ) => {
				const color = resolvedColor( tokens, role );
				return color && 1 !== color.a;
			} );
			expect( translucent ).toEqual( [] );
		} );

		it( 'gives the REPL a surface of its own', () => {
			const tokens = requiredSkin();
			expect( colorKey( resolvedColor( tokens, '--repl-bg' ) ) ).not.toBe(
				colorKey( resolvedColor( tokens, '--paper-3' ) )
			);
		} );

		it( 'defines four distinct ink roles', () => {
			const tokens = requiredSkin();
			expect( INK_ROLES.filter( ( role ) => ! tokens[ role ] ) ).toEqual(
				[]
			);
			const inks = resolvedColors( tokens, INK_ROLES );
			expect(
				INK_ROLES.filter( ( role, index ) => 1 !== inks[ index ].a )
			).toEqual( [] );
			expect( new Set( inks.map( colorKey ) ).size ).toBe( 4 );
		} );

		it( 'orders paper luminance from elevated to base', () => {
			const tokens = requiredSkin();
			const papers = paperColors( slug, tokens ).map( luminance );
			expect( papers[ 0 ] ).toBeGreaterThan( papers[ 1 ] );
			expect( papers[ 1 ] ).toBeGreaterThan( papers[ 2 ] );
		} );

		it( 'strictly descends minimum paper contrast across ink roles', () => {
			const tokens = requiredSkin();
			const papers = paperColors( slug, tokens );
			const minimumContrast = resolvedColors( tokens, INK_ROLES ).map(
				( ink ) =>
					Math.min(
						...papers.map( ( paper ) => contrast( ink, paper ) )
					)
			);
			expect( minimumContrast[ 0 ] ).toBeGreaterThan(
				minimumContrast[ 1 ]
			);
			expect( minimumContrast[ 1 ] ).toBeGreaterThan(
				minimumContrast[ 2 ]
			);
			expect( minimumContrast[ 2 ] ).toBeGreaterThan(
				minimumContrast[ 3 ]
			);
		} );
	} );

	it.each( Object.entries( EXACT_ANCHORS ) )(
		'%s keeps its audited paper and ink anchors',
		( slug, expected ) => {
			const skin = skinMaps.get( slug );
			expect( skin ).toBeDefined();
			expect(
				Object.fromEntries(
					Object.keys( expected ).map( ( role ) => [
						role,
						skin[ role ],
					] )
				)
			).toEqual( expected );
		}
	);

	it( 'keeps the pastel canvas on the elevated paper', () => {
		const pastel = skinMaps.get( 'pastel' );
		expect( pastel ).toBeDefined();
		expect( pastel[ '--canvas' ] ).toBe( 'var(--paper)' );
	} );
} );
