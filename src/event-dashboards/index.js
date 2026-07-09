/**
 * Dashboards Entry Point
 *
 * Registers the hub DevTools tabs the event-dashboards bundle owns (Overview —
 * which folds in the per-topology detail tree — and Raw
 * Logs) via the side-effecting `./tabs` import. There is no standalone React
 * mount — Raw Logs is a hub tab now.
 */

import './nodes/register';
import './tabs';
