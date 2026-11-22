/* @jest-environment node */

/**
 * The shared modal's header metrics, size classes and motion, read from the
 * compiled stylesheets the shell ships: the UI entry for the header, and
 * `Modal.scss` for the box sizes, the bleed and the animation.
 */

import path from 'path';
import * as sass from 'sass';
import postcss from 'postcss';

const { sassImporter } = require( '../../../build-kit/alias-map.cjs' );

const SRC = path.resolve( __dirname, '../../..' );
const UI = path.join( SRC, 'ui/newspack-nodes-ui.scss' );
const MODAL = path.join( SRC, 'shared/components/Modal.scss' );
const compile = ( file ) =>
	postcss.parse(
		sass.compile( file, { importers: [ sassImporter( SRC ) ] } ).css,
		{ from: file }
	);
const ui = compile( UI );
const modal = compile( MODAL );

const BOX = '.newspack-nodes-modal';
const SHARED = `:where(.newspack-nodes-ui) ${ BOX }`;
const HEADER = `${ SHARED } ${ BOX }__header`;
const TITLE = `${ SHARED } ${ BOX }__title`;
const ACTIONS = `${ SHARED } ${ BOX }__header-actions`;
const SIZED = ( size ) => `${ BOX }__backdrop > ${ BOX }--${ size }`;
const MOTION = 'not (prefers-reduced-motion)';

// The value a property takes in the last rule naming exactly `selector`.
const value = ( sheet, selector, property ) => {
	let found;
	sheet.each( ( rule ) => {
		if ( 'rule' !== rule.type || ! rule.selectors.includes( selector ) ) {
			return;
		}
		rule.each( ( d ) => {
			if ( 'decl' === d.type && property === d.prop ) {
				found = d.value;
			}
		} );
	} );
	return found;
};

const motion = ( sheet ) =>
	sheet.nodes.filter( ( n ) => 'atrule' === n.type && 'media' === n.name );
const guarded = motion( modal ).filter( ( n ) => MOTION === n.params );
const inMotion = ( name ) =>
	guarded.flatMap( ( g ) => g.nodes ).filter( ( n ) => name( n ) );
const keyframes = ( name ) =>
	inMotion( ( n ) => 'atrule' === n.type && 'keyframes' === n.name ).find(
		( n ) => name === n.params
	);
const frame = ( kf, stop, prop ) => {
	let found;
	kf.each( ( step ) => {
		if ( step.selector === stop ) {
			step.each( ( d ) => {
				if ( d.prop === prop ) {
					found = d.value;
				}
			} );
		}
	} );
	return found;
};
const motionRule = ( selector, prop ) => {
	let found;
	inMotion( ( n ) => 'rule' === n.type ).forEach( ( r ) => {
		if ( r.selectors.includes( selector ) ) {
			r.each( ( d ) => {
				if ( d.prop === prop ) {
					found = d.value;
				}
			} );
		}
	} );
	return found;
};

describe( 'the regular header', () => {
	it.each( [
		[ 'min-height', '64px' ],
		[ 'padding', '0 18px' ],
	] )( 'sets %s to %s', ( property, expected ) => {
		expect( value( ui, HEADER, property ) ).toBe( expected );
	} );

	it( 'sets the title at 18px and truncates it beside the actions', () => {
		expect( value( ui, TITLE, 'font-size' ) ).toBe( '18px' );
		expect( value( ui, TITLE, 'min-width' ) ).toBe( '0' );
		expect( value( ui, TITLE, 'text-overflow' ) ).toBe( 'ellipsis' );
	} );

	it( 'rules the header edge to edge', () => {
		expect( value( ui, HEADER, 'border-bottom' ) ).toMatch( /^1px solid/ );
	} );
} );

describe( 'the compact header', () => {
	it( 'pads 8px 8px 8px 16px with no minimum height', () => {
		expect( value( ui, `${ HEADER }--compact`, 'padding' ) ).toBe(
			'8px 8px 8px 16px'
		);
		expect( value( ui, `${ HEADER }--compact`, 'min-height' ) ).toBe( '0' );
	} );

	it( 'keeps the title at the medium text size', () => {
		expect(
			value( ui, `${ HEADER }--compact ${ BOX }__title`, 'font-size' )
		).toBe( 'var(--np-text-m)' );
	} );
} );

describe( 'the header actions', () => {
	it( 'hold their width beside a long title', () => {
		expect( value( ui, ACTIONS, 'flex' ) ).toBe( 'none' );
		expect( value( ui, ACTIONS, 'display' ) ).toBe( 'flex' );
		expect( value( ui, ACTIONS, 'gap' ) ).toBe( 'var(--np-space-sm)' );
	} );
} );

describe( 'the padded shared box', () => {
	const BLEED = `${ BOX }__backdrop > ${ BOX } > ${ BOX }__header`;

	it( 'bleeds the header to the frame', () => {
		expect( value( modal, BLEED, 'margin' ) ).toBe(
			'calc(-1 * var(--np-space-lg)) calc(-1 * var(--np-space-lg)) var(--np-space-lg)'
		);
	} );

	// The sticky edge sits at the box's content edge, inside its padding, so
	// the offset lifts the header by that padding to the box's top edge, where
	// the bleed already draws it.
	it( 'holds the header flush at the top of a scrolling box', () => {
		expect( value( modal, BLEED, 'position' ) ).toBe( 'sticky' );
		expect( value( modal, BLEED, 'top' ) ).toBe(
			'calc(-1 * var(--np-space-lg))'
		);
		expect( value( modal, BLEED, 'z-index' ) ).toBe( '1' );
	} );

	it( 'paints the sticky header its own opaque surface, over the body', () => {
		expect( value( ui, HEADER, 'background' ) ).toBe(
			'var(--paper-2, var(--np-surface-subtle))'
		);
	} );

	it( "leaves the console's unpadded box, which scrolls its body, unstuck", () => {
		const stuck = [];
		modal.walkRules( ( rule ) => {
			if (
				rule.selector.includes( 'topology-modal' ) &&
				rule.nodes.some(
					( d ) => 'decl' === d.type && 'position' === d.prop
				)
			) {
				stuck.push( rule.selector );
			}
		} );
		expect( stuck ).toEqual( [] );
	} );

	it.each( [
		[ 'small', '384px' ],
		[ 'medium', '640px' ],
		[ 'large', '840px' ],
	] )( 'caps %s at %s', ( size, width ) => {
		expect( value( modal, SIZED( size ), 'max-width' ) ).toBe( width );
	} );

	it( 'fills the viewport for fullscreen, unrounded', () => {
		const full = SIZED( 'fullscreen' );
		expect( value( modal, full, 'width' ) ).toBe( '100vw' );
		expect( value( modal, full, 'height' ) ).toBe( '100vh' );
		expect( value( modal, full, 'max-width' ) ).toBe( 'none' );
		expect( value( modal, full, 'max-height' ) ).toBe( 'none' );
		expect( value( modal, full, 'border-radius' ) ).toBe( '0' );
	} );

	it( 'sizes fullscreen in the shared backdrop alone, with no padding reset', () => {
		const fullscreen = [];
		modal.walkRules( ( rule ) => {
			if ( rule.selector.includes( `${ BOX }--fullscreen` ) ) {
				fullscreen.push( rule.selector );
			}
		} );
		expect( fullscreen ).toEqual( [ SIZED( 'fullscreen' ) ] );
	} );
} );

describe( 'the motion', () => {
	it( 'keeps every keyframe and animation inside the reduced-motion guard', () => {
		const outside = [];
		modal.walk( ( n ) => {
			const guard =
				n.parent && 'atrule' === n.parent.type
					? n.parent
					: n.parent && n.parent.parent;
			const inGuard =
				guard && 'media' === guard.name && MOTION === guard.params;
			const moving =
				( 'atrule' === n.type && 'keyframes' === n.name ) ||
				( 'decl' === n.type && /^animation/.test( n.prop ) );
			if ( moving && ! inGuard ) {
				outside.push( n.toString() );
			}
		} );
		expect( outside ).toEqual( [] );
		expect( guarded ).toHaveLength( 1 );
	} );

	// The `scale` property, so a box's own `transform` (the console's centring
	// translate in the debug overlay) stays in force while it animates.
	it( 'appears from 0.9 scale and fades in the backdrop', () => {
		const appear = keyframes( 'newspack-nodes-modal-appear' );
		expect( frame( appear, 'from', 'opacity' ) ).toBe( '0' );
		expect( frame( appear, 'from', 'scale' ) ).toBe( '0.9' );
		expect( frame( appear, 'to', 'scale' ) ).toBe( '1' );
		expect( frame( appear, 'from', 'transform' ) ).toBeUndefined();
		expect( frame( appear, 'to', 'transform' ) ).toBeUndefined();
		expect(
			frame(
				keyframes( 'newspack-nodes-modal-fade-in' ),
				'from',
				'opacity'
			)
		).toBe( '0' );
	} );

	it( 'disappears to 0.9 scale and fades the backdrop out', () => {
		const gone = keyframes( 'newspack-nodes-modal-disappear' );
		expect( frame( gone, 'to', 'opacity' ) ).toBe( '0' );
		expect( frame( gone, 'from', 'scale' ) ).toBe( '1' );
		expect( frame( gone, 'to', 'scale' ) ).toBe( '0.9' );
		expect( frame( gone, 'from', 'transform' ) ).toBeUndefined();
		expect( frame( gone, 'to', 'transform' ) ).toBeUndefined();
		expect(
			frame(
				keyframes( 'newspack-nodes-modal-fade-out' ),
				'to',
				'opacity'
			)
		).toBe( '0' );
	} );

	it.each( [
		'.newspack-nodes-modal__backdrop',
		'.topology-modal-backdrop',
	] )(
		'times the %s: 80ms in, 80ms out after an 80ms delay',
		( backdrop ) => {
			expect( motionRule( backdrop, 'animation' ) ).toBe(
				'newspack-nodes-modal-fade-in 80ms linear'
			);
			const closing = `${ backdrop }.is-closing`;
			expect( motionRule( closing, 'animation' ) ).toBe(
				'newspack-nodes-modal-fade-out 80ms linear 80ms forwards'
			);
		}
	);

	it.each( [
		'.newspack-nodes-modal__backdrop',
		'.topology-modal-backdrop',
	] )( 'times the box in a %s: 200ms in and out', ( backdrop ) => {
		expect( motionRule( `${ backdrop } > ${ BOX }`, 'animation' ) ).toBe(
			'newspack-nodes-modal-appear 200ms ease-out'
		);
		expect(
			motionRule( `${ backdrop }.is-closing > ${ BOX }`, 'animation' )
		).toBe( 'newspack-nodes-modal-disappear 200ms ease-in forwards' );
	} );
} );
