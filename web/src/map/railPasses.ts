import type { TrainPass } from '../api.js';
import { baseRailLayerIds } from './baseRailHighlight.js';
import type { LegendLayer } from './legend.js';

export interface TrainPassesResponse {
  configured: boolean;
  passes: TrainPass[];
}

export function clickableRailLayerIds(layers: readonly LegendLayer[], isVisible: (id: string) => boolean): string[] {
  const ids = ['rail-lines', ...baseRailLayerIds([...layers])];
  return ids.filter((id, index) => ids.indexOf(id) === index && isVisible(id));
}

export function buildRailPassPopupHtml(result: TrainPassesResponse, now = new Date()): string {
  if (!result.configured) {
    return '<div role="dialog" aria-label="Passenger train passes"><strong>Passenger trains</strong><br/><span>TfNSW trains are not configured.</span></div>';
  }
  if (!result.passes.length) {
    return '<div role="dialog" aria-label="Passenger train passes"><strong>Passenger trains</strong><br/><span>No scheduled passenger trains pass here in the next 6 hours.</span></div>';
  }
  const rows = result.passes.map((p) => {
    const route = escapeHtml(p.route || 'Train');
    const headsign = p.headsign ? ` <span>→ ${escapeHtml(p.headsign)}</span>` : '';
    return `<li><strong>${route}</strong>${headsign}<br/><time datetime="${escapeHtml(p.at)}">${escapeHtml(localTime(p.at, now))}</time></li>`;
  }).join('');
  return `<div role="dialog" aria-label="Passenger train passes"><strong>Passenger trains</strong><ul class="rail-pass-list">${rows}</ul></div>`;
}

function localTime(iso: string, now: Date): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) + (sameDay ? '' : ` ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
