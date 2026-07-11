import { Node } from './node';

export class HookNode extends Node {
	constructor( predicate ) {
		super();
		this._predicate = predicate;
	}

	fill( message ) {
		this.counter++;
		if ( this._predicate( message ) && this.sink ) {
			this.sink.fill( message );
		}
	}
}
