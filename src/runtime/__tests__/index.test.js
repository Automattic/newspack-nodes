import * as runtime from '../index';
import { raise } from '../failures';

test( 'public surface exports everything used by dashboards', () => {
	expect( runtime.Node ).toBeDefined();
	expect( runtime.RouterNode ).toBeDefined();
	expect( runtime.TeeNode ).toBeDefined();
	expect( runtime.HookNode ).toBeDefined();
	expect( runtime.CallbackNode ).toBeDefined();
	expect( runtime.TimerNode ).toBeDefined();
	expect( runtime.CommandInterpreterNode ).toBeDefined();
	expect( runtime.SseInNode ).toBeDefined();
	expect( runtime.commandTransport ).toBeDefined();
	expect( runtime.defaultTransport ).toBeDefined();
	expect( runtime.Core ).toBeDefined();
	expect( runtime.useNodeState ).toBeDefined();
	expect( runtime.useNodeFill ).toBeDefined();
	expect( runtime.TYPE ).toBe( 0 );
	expect( runtime.TM_COMMAND ).toBe( 8 );
	expect( runtime.newMessage ).toBeDefined();
} );

test( 'public surface exports the one raise every fan-out throws through', () => {
	expect( runtime.raise ).toBe( raise );
} );
