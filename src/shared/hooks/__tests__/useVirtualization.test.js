/**
 * Tests for useVirtualization — window-scroll, self-scroll, and parent-
 * container scroll modes, plus the OVERSCAN padding math.
 */

import { renderHook, act } from '@testing-library/react';
import { useRef } from '@wordpress/element';
import useVirtualization from '../useVirtualization';

const ROW = 20;

describe( 'useVirtualization', () => {
	it( 'returns the no-op slice when listRef.current is null', () => {
		const { result } = renderHook( () => {
			const ref = useRef( null );
			return useVirtualization( ref, ROW, 100 );
		} );
		expect( result.current.startIndex ).toBe( 0 );
		expect( result.current.totalHeight ).toBe( 100 * ROW );
	} );

	it( 'window mode: returns 0..count when element is at the top of the viewport', () => {
		const el = document.createElement( 'div' );
		el.getBoundingClientRect = () => ( {
			top: 0,
			bottom: 1000,
			height: 1000,
		} );
		Object.defineProperty( window, 'innerHeight', {
			configurable: true,
			value: 600,
		} );

		const { result } = renderHook( () => {
			const ref = useRef( el );
			return useVirtualization( ref, ROW, 200 );
		} );
		// top=0, height=600 -> start=max(0, 0/20-5)=0, count=ceil(600/20)+10=40
		expect( result.current.startIndex ).toBe( 0 );
		expect( result.current.endIndex ).toBe( 40 );
		expect( result.current.offsetTop ).toBe( 0 );
		expect( result.current.paddingTop ).toBe( 0 );
		expect( result.current.paddingBottom ).toBe( ( 200 - 40 ) * ROW );
		expect( result.current.totalHeight ).toBe( 200 * ROW );
	} );

	it( 'window mode: skips update when element is fully out of view', () => {
		const el = document.createElement( 'div' );
		el.getBoundingClientRect = () => ( {
			top: 2000,
			bottom: 3000,
			height: 1000,
		} );
		Object.defineProperty( window, 'innerHeight', {
			configurable: true,
			value: 600,
		} );

		const { result } = renderHook( () => {
			const ref = useRef( el );
			return useVirtualization( ref, ROW, 200 );
		} );
		// Offscreen: update() short-circuits, leaving the initial scroll state.
		expect( result.current.startIndex ).toBe( 0 );
	} );

	it( 'self mode: uses element scrollTop and clientHeight', () => {
		const el = document.createElement( 'div' );
		Object.defineProperty( el, 'scrollTop', {
			configurable: true,
			get: () => 400,
		} );
		Object.defineProperty( el, 'clientHeight', {
			configurable: true,
			get: () => 200,
		} );

		const { result } = renderHook( () => {
			const ref = useRef( el );
			return useVirtualization( ref, ROW, 200, 'self' );
		} );
		// top=400, height=200 -> start=max(0,20-5)=15, count=ceil(200/20)+10=20
		expect( result.current.startIndex ).toBe( 15 );
		expect( result.current.endIndex ).toBe( 35 );
		expect( result.current.offsetTop ).toBe( 15 * ROW );
	} );

	it( 'container mode: uses container rect minus element rect', () => {
		const container = document.createElement( 'div' );
		container.className = 'host';
		document.body.appendChild( container );
		const el = document.createElement( 'div' );
		container.appendChild( el );

		container.getBoundingClientRect = () => ( {
			top: 50,
			bottom: 250,
			height: 200,
		} );
		el.getBoundingClientRect = () => ( {
			top: 30,
			bottom: 230,
			height: 200,
		} );

		const { result } = renderHook( () => {
			const ref = useRef( el );
			return useVirtualization( ref, ROW, 200, '.host' );
		} );
		// container offset 20, height 200 -> start 0, count 20.
		expect( result.current.startIndex ).toBe( 0 );
		expect( result.current.endIndex ).toBe( 20 );
	} );

	it( 'updates on window resize event', () => {
		const el = document.createElement( 'div' );
		el.getBoundingClientRect = () => ( {
			top: -100,
			bottom: 900,
			height: 1000,
		} );
		Object.defineProperty( window, 'innerHeight', {
			configurable: true,
			value: 600,
		} );

		const { result } = renderHook( () => {
			const ref = useRef( el );
			return useVirtualization( ref, ROW, 200 );
		} );
		// top=100, count=40 -> start=max(0, 5-5)=0; endIndex=count=40
		expect( result.current.startIndex ).toBe( 0 );

		act( () => {
			el.getBoundingClientRect = () => ( {
				top: -200,
				bottom: 800,
				height: 1000,
			} );
			window.dispatchEvent( new Event( 'resize' ) );
		} );
		// top=200 -> start=floor(200/20)-5=5
		expect( result.current.startIndex ).toBe( 5 );
	} );

	it( 'applies scrollOffset when computing start index', () => {
		const el = document.createElement( 'div' );
		Object.defineProperty( el, 'scrollTop', {
			configurable: true,
			get: () => 100,
		} );
		Object.defineProperty( el, 'clientHeight', {
			configurable: true,
			get: () => 200,
		} );

		const { result } = renderHook( () => {
			const ref = useRef( el );
			return useVirtualization( ref, ROW, 100, 'self', 200 );
		} );
		// effectiveTop = 100 + 200 = 300; start = floor(300/20) - 5 = 10
		expect( result.current.startIndex ).toBe( 10 );
	} );

	it( 'clamps endIndex at totalRows', () => {
		const el = document.createElement( 'div' );
		Object.defineProperty( el, 'scrollTop', {
			configurable: true,
			get: () => 99999,
		} );
		Object.defineProperty( el, 'clientHeight', {
			configurable: true,
			get: () => 200,
		} );

		const { result } = renderHook( () => {
			const ref = useRef( el );
			return useVirtualization( ref, ROW, 10, 'self' );
		} );
		expect( result.current.endIndex ).toBe( 10 );
		expect( result.current.paddingBottom ).toBe( 0 );
	} );

	it( 'unmount removes scroll + resize listeners', () => {
		const el = document.createElement( 'div' );
		Object.defineProperty( el, 'scrollTop', {
			configurable: true,
			get: () => 0,
		} );
		Object.defineProperty( el, 'clientHeight', {
			configurable: true,
			get: () => 200,
		} );
		const removeWin = jest.spyOn( window, 'removeEventListener' );
		const removeEl = jest.spyOn( el, 'removeEventListener' );

		const { unmount } = renderHook( () => {
			const ref = useRef( el );
			return useVirtualization( ref, ROW, 50, 'self' );
		} );
		unmount();

		expect( removeEl ).toHaveBeenCalledWith(
			'scroll',
			expect.any( Function )
		);
		expect( removeWin ).toHaveBeenCalledWith(
			'resize',
			expect.any( Function )
		);
		removeWin.mockRestore();
		removeEl.mockRestore();
	} );
} );
