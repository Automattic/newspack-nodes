import { Node } from './node';

export class Hook extends Node {
	constructor( predicate ) {
		super();
		this._predicate = predicate;
	}

	fill( message ) {
		this.counter += 1;
		if ( this._predicate( message ) && this.sink ) {
			this.sink.fill( message );
		}
	}
}
