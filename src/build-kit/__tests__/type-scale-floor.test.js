/**
 * type-scale-floor tests — the one reading of a font size against the type
 * scale's smallest step, `--np-text-2xs` (12px), that every plugin's floor
 * test runs over its stylesheets and scripts.
 */

const postcss = require( 'postcss' );
const {
	belowFloor,
	stylesheetOffenders,
	scriptOffenders,
} = require( '../type-scale-floor.cjs' );

describe( 'belowFloor', () => {
	it.each( [
		[ 'font-size', '11.5px' ],
		[ 'font-size', '0.7rem' ],
		[ 'font-size', '0.6em' ],
		[ 'font-size', 'x-small' ],
		[ 'font', '700 9px var(--font-mono)' ],
		[ 'font', 'italic 600 10px/1.4 "Fira Code", monospace' ],
		[ 'font', '400 0.625rem / 1.5 var(--font-terminal)' ],
	] )( 'refuses %s: %s', ( prop, value ) => {
		expect( belowFloor( prop, value ) ).toBe( true );
	} );

	it.each( [
		[ 'font-size', '12px' ],
		[ 'font-size', '0.75rem' ],
		[ 'font-size', 'var(--np-text-2xs)' ],
		[ 'font-size', 'inherit' ],
		[ 'font', '700 var(--np-text-2xs) / 1 var(--font-mono)' ],
		[ 'font', '500 13px/1.1 var(--font-mono)' ],
		[ 'font', 'inherit' ],
	] )( 'admits %s: %s', ( prop, value ) => {
		expect( belowFloor( prop, value ) ).toBe( false );
	} );
} );

describe( 'stylesheetOffenders', () => {
	it( 'names each rule setting type below the floor, by its label', () => {
		const sheet = postcss.parse(
			'.kea { font: 700 0.65rem/1.2 mono; } .tui { font-size: 13px; }' +
				'.moa .huia { font-size: 10px; letter-spacing: 9px; }'
		);
		expect( stylesheetOffenders( sheet, 'birds.scss' ) ).toEqual( [
			'birds.scss:.kea font: 700 0.65rem/1.2 mono',
			'birds.scss:.moa .huia font-size: 10px',
		] );
	} );

	it( 'names a declaration an at-rule holds by the at-rule', () => {
		const sheet = postcss.parse(
			'@page { font-size: 9px; } @font-face { font-size: 14px; }'
		);
		expect( stylesheetOffenders( sheet, 'print.scss' ) ).toEqual( [
			'print.scss:@page font-size: 9px',
		] );
	} );
} );

describe( 'a size a token sets', () => {
	it( 'reads a var() by its fallback, and names a token without one', () => {
		const sheet = postcss.parse(
			'.a { font-size: var(--kea, 16px); }' +
				'.b { font-size: var(--kea,9px); }' +
				'.c { font-size: var(--kea); }' +
				'.d { font-size: var(--np-text-2xs); }' +
				'.e { font: 700 var(--moa, 0.6rem) / 1 mono; }'
		);
		expect( stylesheetOffenders( sheet, 't.scss' ) ).toEqual( [
			't.scss:.b font-size: var(--kea,9px)',
			't.scss:.c font-size: var(--kea) (token size)',
			't.scss:.e font: 700 var(--moa, 0.6rem) / 1 mono',
		] );
	} );

	it( 'reports a font it cannot place as unreadable and reads on', () => {
		const sheet = postcss.parse(
			'.a { font: bold 14px; } .b { font-size: 10px; }'
		);
		expect( stylesheetOffenders( sheet, 'u.scss' ) ).toEqual( [
			'u.scss:.a font: bold 14px (unreadable)',
			'u.scss:.b font-size: 10px',
		] );
	} );
} );

describe( 'a size it does not model', () => {
	it( 'fails closed on every form it does not model', () => {
		const sheet = postcss.parse(
			[
				'round(9px, 1px)',
				'-webkit-calc(9px)',
				'+9px',
				'9e0px',
				'9.px',
				'env(x, 9px)',
				'constructor',
				'var(--NP-TEXT-S)',
				'medium',
				'larger',
				'0',
				'9constructor',
			]
				.map( ( size, at ) => `.s${ at } { font-size: ${ size }; }` )
				.join( '' )
		);
		expect( stylesheetOffenders( sheet, 'c.scss' ) ).toEqual( [
			'c.scss:.s0 font-size: round(9px, 1px) (unreadable)',
			'c.scss:.s1 font-size: -webkit-calc(9px) (unreadable)',
			'c.scss:.s2 font-size: +9px',
			'c.scss:.s3 font-size: 9e0px',
			'c.scss:.s4 font-size: 9.px',
			'c.scss:.s5 font-size: env(x, 9px) (unreadable)',
			'c.scss:.s6 font-size: constructor (unreadable)',
			'c.scss:.s7 font-size: var(--NP-TEXT-S) (token size)',
			'c.scss:.s10 font-size: 0',
			'c.scss:.s11 font-size: 9constructor (unreadable)',
		] );
	} );
} );

describe( 'a function closed where it ends, and a keyword in any case', () => {
	it( 'reads a function only when it closes at the end of the size', () => {
		const sheet = postcss.parse(
			'.a { font-size: calc(var(--np-text-xs, 0px) - var(--g, 6px)); }' +
				'.b { font-size: X-SMALL; }' +
				'.c { font: 700 var(--np-text-2xs) var(--font-mono); }' +
				'.d { font-size: VAR(--np-text-s); }'
		);
		expect( stylesheetOffenders( sheet, 'f.scss' ) ).toEqual( [
			'f.scss:.a font-size: calc(var(--np-text-xs, 0px) - var(--g, 6px)) (unreadable)',
			'f.scss:.b font-size: X-SMALL',
		] );
	} );
} );

describe( 'a size relative to its parent, or a scale token in a function', () => {
	it( 'reads a percentage as an em, and a scale token as the floor itself', () => {
		const sheet = postcss.parse(
			'.a { font-size: 70%; } .b { font-size: 80%; }' +
				'.c { font-size: clamp(var(--np-text-2xs), 2vw, 20px); }' +
				'.d { font-size: max(var(--np-text-xs), 1vw); }' +
				'.e { font-size: min(var(--np-text-2xs), 10px); }' +
				'.f { font-size: min(1vw, 13px); }'
		);
		expect( stylesheetOffenders( sheet, 'p.scss' ) ).toEqual( [
			'p.scss:.a font-size: 70%',
			'p.scss:.e font-size: min(var(--np-text-2xs), 10px)',
			'p.scss:.f font-size: min(1vw, 13px) (unreadable)',
		] );
	} );
} );

describe( 'a size a math function or a viewport unit sets', () => {
	it( 'checks a math size by its least readable value, else reports it unreadable', () => {
		const sheet = postcss.parse(
			'.a { font-size: clamp(10px, 2vw, 14px); }' +
				'.b { font-size: clamp(12px, 2vw, 14px); }' +
				'.c { font-size: calc(1vw + 2px); }' +
				'.d { font: 700 max(10px, 0.5rem) mono; }' +
				'.e { font-size: min(0.875rem, 13px); }' +
				'.f { font-size: 2vmin; }'
		);
		expect( stylesheetOffenders( sheet, 'm.scss' ) ).toEqual( [
			'm.scss:.a font-size: clamp(10px, 2vw, 14px)',
			'm.scss:.c font-size: calc(1vw + 2px) (unreadable)',
			'm.scss:.d font: 700 max(10px, 0.5rem) mono',
			'm.scss:.f font-size: 2vmin (unreadable)',
		] );
	} );
} );

describe( 'scriptOffenders', () => {
	it( 'reports a setter whose value is an expression as unreadable', () => {
		const source = [
			'style={ { fontSize: size } }',
			"node.style( 'font-size', big ? '14px' : '10px' );",
			"ctx.font = weight + ' 12px Inter';",
			"style={ { fontSize: 'X-SMALL' } }",
			"style={ { fontSize: '13px' } }",
			'const font = getFont();',
		].join( '\n' );
		expect( scriptOffenders( source, 'Expr.js' ) ).toEqual( [
			'Expr.js:1 (unreadable)',
			'Expr.js:2 (unreadable)',
			'Expr.js:3 (unreadable)',
			'Expr.js:4',
		] );
	} );

	it( 'reads a script size setter in any unit, keyword or math function', () => {
		const source = [
			"style={ { fontSize: '8pt' } }",
			"node.style( 'font-size', 'x-small' );",
			"style={ { fontSize: 'clamp(8px, 2vw, 14px)' } }",
			"style={ { fontSize: '10pt' } }",
			"node.attr( 'font-size', 'var(--kea, 9px)' );",
		].join( '\n' );
		expect( scriptOffenders( source, 'Size.js' ) ).toEqual( [
			'Size.js:1',
			'Size.js:2',
			'Size.js:3',
			'Size.js:5',
		] );
	} );

	it( 'reads a script font string leniently, skipping text that is not a font value', () => {
		const source = [
			'const msg = `font: ${ size }px`;',
			"alert( 'font: is not set' );",
			'ctx.font = "10px";',
			'ctx.font = `${ weight } 9px mono`;',
			"const label = { font: 'bold' };",
			'ctx.font = "600 13px Inter";',
		].join( '\n' );
		expect( scriptOffenders( source, 'Canvas.js' ) ).toEqual( [
			'Canvas.js:1 (unreadable)',
			'Canvas.js:3',
			'Canvas.js:4',
		] );
	} );

	it( 'reads a quoted key, an interpolated size and a slash inside a function', () => {
		const source = [
			"const a = { 'fontSize': '10px' };",
			'const b = {"font": "9px Arial"};',
			'ctx.font = `${n}px Arial`;',
			"ctx.font = 'calc(20px/2) Arial';",
			"const c = { 'fontSize': '13px' };",
		].join( '\n' );
		expect( scriptOffenders( source, 'Keys.js' ) ).toEqual( [
			'Keys.js:1',
			'Keys.js:2',
			'Keys.js:3 (unreadable)',
			'Keys.js:4 (unreadable)',
		] );
	} );

	it( 'ends a size in CSS text at a brace, a quote or !important', () => {
		const source = [
			"const rule = '.a{font-size:11px}';",
			`node.innerHTML = "<span style='font-size:11px'>kea</span>";`,
			"node.style.cssText = 'font-size: 11px !important';",
			"node.style.cssText = 'font-size: 13px !important';",
			`const css = '.x{font:10px "Inter",sans-serif}';`,
			`node.innerHTML = "<b style='font: 700 9px mono'>kea</b>";`,
			`const ok = '.y{font:13px "Inter",sans-serif}';`,
		].join( '\n' );
		expect( scriptOffenders( source, 'Row.js' ) ).toEqual( [
			'Row.js:1',
			'Row.js:2',
			'Row.js:3',
			'Row.js:5',
			'Row.js:6',
		] );
	} );

	it( 'reads a quoted font-size key, CSS across a template literal, and a percentage', () => {
		const source = [
			"const style = { 'font-size': '10px' };",
			'const css = `',
			'	color: teal;',
			'	font-size: 0.65rem;',
			'`;',
			"const relative = { fontSize: '10%', 'font-size': '50%' };",
			"node.style.cssText = 'font-size: 9px; font: 700 10px mono';",
		].join( '\n' );
		expect( scriptOffenders( source, 'Panel.js' ) ).toEqual( [
			'Panel.js:1',
			'Panel.js:4',
			'Panel.js:6',
			'Panel.js:7',
		] );
	} );

	it( 'names each line a script sets type below the floor on', () => {
		const source = [
			"style={ { fontSize: '11px' } }",
			'style={ { fontSize: 10 } }',
			"node.style( 'font-size', '13px' );",
			"node.attr( 'font-size', 9 );",
			'<text fontSize={ 8 } />',
			"style={ { fontSize: '0.7rem' } }",
			"style={ { fontSize: 'var(--np-text-2xs)' } }",
			"ctx.font = '10px var(--font-mono)';",
			"const label = { font: '700 9px Inter', fill: 'teal' };",
			"node.style.cssText = 'color: teal; font-size: 0.6rem';",
			"node.style.cssText = 'font: italic 11px/1.4 mono;';",
			"ctx.font = '600 13px Inter';",
			"const css = 'font-size: 12px; font: 700 14px mono';",
		].join( '\n' );
		expect( scriptOffenders( source, 'Chart.js' ) ).toEqual( [
			'Chart.js:1',
			'Chart.js:2',
			'Chart.js:4',
			'Chart.js:5',
			'Chart.js:6',
			'Chart.js:8',
			'Chart.js:9',
			'Chart.js:10',
			'Chart.js:11',
		] );
	} );
} );
