import * as runtime from '../index';

test( 'public surface exports everything used by dashboards', () => {
	expect( runtime.Node ).toBeDefined();
	expect( runtime.Router ).toBeDefined();
	expect( runtime.Tee ).toBeDefined();
	expect( runtime.Hook ).toBeDefined();
	expect( runtime.Callback ).toBeDefined();
	expect( runtime.Timer ).toBeDefined();
	expect( runtime.CommandInterpreter ).toBeDefined();
	expect( runtime.SseConnector ).toBeDefined();
	expect( runtime.CommandClient ).toBeDefined();
	expect( runtime.Core ).toBeDefined();
	expect( runtime.useNodeState ).toBeDefined();
	expect( runtime.useNodeFill ).toBeDefined();
	expect( runtime.TYPE ).toBe( 0 );
	expect( runtime.TM_COMMAND ).toBe( 8 );
	expect( runtime.newMessage ).toBeDefined();
} );
