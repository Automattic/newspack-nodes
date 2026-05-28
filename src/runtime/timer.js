import { Node } from './node';

/**
 * Timer — a repeating setInterval Node. `make_node Timer t 1000` auto-starts
 * a 1s timer; the `arguments` setter parses the positional interval and calls
 * setInterval(ms). fireCb is called each tick.
 */
export class Timer extends Node {
	constructor() {
		super();
		this.fireCb = () => {};
		this._handle = null;
		this._intervalMs = 0;
	}

	static nodeSchema() {
		return {
			category: 'Control',
			description: 'Repeating setInterval Node; fires fireCb each tick.',
			arguments: [
				{
					name: 'interval_ms',
					type: 'int',
					required: false,
					default: 0,
				},
			],
			commands: [],
		};
	}

	get arguments() {
		return super.arguments;
	}

	// Tachikoma arguments() setter: schema walker assigns interval_ms; if >0,
	// auto-start (mirrors Router self-start). Calling with 0 / empty stops.
	set arguments( value ) {
		super.arguments = value;
		const ms = Number.isInteger( this.interval_ms ) ? this.interval_ms : 0;
		if ( ms > 0 ) {
			this.setInterval( ms );
		} else {
			this.stop();
		}
	}

	setInterval( ms ) {
		this.stop();
		this._intervalMs = ms;
		this._handle = setInterval( () => this.fireCb(), ms );
	}

	stop() {
		if ( null !== this._handle ) {
			clearInterval( this._handle );
			this._handle = null;
		}
	}

	removeNode() {
		this.stop();
		super.removeNode();
	}
}
