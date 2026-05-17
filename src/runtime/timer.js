import { Node } from './node';

export class Timer extends Node {
	constructor() {
		super();
		this.fireCb = () => {};
		this._handle = null;
		this._intervalMs = 0;
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
}
