/**
 * Topology Console bundle entry. 5b removed the standalone console page; the
 * Console is a hub tab now, so this file's only job is to register that tab when
 * the bundle loads. The side-effect imports do the work: `./tabs` calls
 * registerDevtoolsTab, `./includeConsoleNodes` and the stylesheet pull in what
 * the tab's component needs.
 */

import './includeConsoleNodes';
import './tabs';
import './styles/topology-console.scss';
