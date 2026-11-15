// Pure helpers for multi-monitor placement. Electron still converts the Codex
// client rect with screenToDipRect(null, …); these functions only decide which
// display that DIP rect lands on, and where to pull a window that lost its screen.

const SCREEN_EVENT_DELAY_MS = 50;

function scaleFactorOf(display) {
  const value = Number(display?.scaleFactor);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function displayBounds(display) {
  return display?.workArea || display?.bounds || null;
}

function containsPoint(bounds, x, y) {
  if (!bounds || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  return x >= bounds.x && y >= bounds.y && x < bounds.x + bounds.width && y < bounds.y + bounds.height;
}

function intersects(a, b) {
  if (!a || !b) return false;
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function displayForPoint(displays, x, y) {
  if (!Array.isArray(displays)) return null;
  return displays.find(display => containsPoint(display?.bounds, x, y))
    || displays.find(display => containsPoint(displayBounds(display), x, y))
    || null;
}

function displayForRect(displays, rect) {
  if (!rect) return null;
  return displayForPoint(displays, rect.x + Math.min(Math.max(rect.width, 0) / 2, Math.max(rect.width - 1, 0)),
    rect.y + Math.min(Math.max(rect.height, 0) / 2, Math.max(rect.height - 1, 0)));
}

function crossedDisplay(previousId, nextId) {
  return previousId != null && nextId != null && previousId !== nextId;
}

function noteDisplay(previous, displays, area) {
  const hit = displayForRect(displays, area);
  const nextId = hit?.id ?? null;
  const scaleFactor = scaleFactorOf(hit);
  return {
    displayId: nextId,
    scaleFactor,
    crossed: crossedDisplay(previous?.displayId ?? null, nextId),
    scaleChanged: previous?.scaleFactor != null && scaleFactor !== previous.scaleFactor
  };
}

function windowCenter(bounds) {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function nearestDisplay(bounds, displays) {
  if (!bounds || !Array.isArray(displays) || !displays.length) return null;
  const center = windowCenter(bounds);
  let best = null;
  let bestDistance = Infinity;
  for (const display of displays) {
    const area = display?.bounds || displayBounds(display);
    if (!area) continue;
    const dx = Math.max(area.x - center.x, 0, center.x - (area.x + area.width));
    const dy = Math.max(area.y - center.y, 0, center.y - (area.y + area.height));
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) { bestDistance = distance; best = display; }
  }
  return best;
}

const SCREEN_KIND_RANK = Object.freeze({ removed: 3, added: 2, metrics: 1 });

function mergeScreenEvent(current, next) {
  const incoming = {
    kind: next?.kind || 'metrics',
    changedMetrics: Array.isArray(next?.changedMetrics) ? next.changedMetrics.filter(item => typeof item === 'string') : []
  };
  if (!current) return incoming;
  const kind = (SCREEN_KIND_RANK[incoming.kind] || 0) > (SCREEN_KIND_RANK[current.kind] || 0)
    ? incoming.kind : current.kind;
  return { kind, changedMetrics: [...new Set([...(current.changedMetrics || []), ...incoming.changedMetrics])] };
}

function metricsNeedRelayout(changedMetrics) {
  return Array.isArray(changedMetrics)
    && (changedMetrics.includes('scaleFactor') || changedMetrics.includes('workArea'));
}

function planScreenEvent({ kind, changedMetrics, dragging = false, scopeValid = true } = {}) {
  if (kind === 'metrics') {
    if (!metricsNeedRelayout(changedMetrics)) return { ignore: true };
    return { cancelSettle: true, clearCache: true, reposition: true };
  }
  if (kind === 'removed') {
    return {
      cancelDrag: Boolean(dragging),
      cancelSettle: true,
      clearCache: true,
      hide: !scopeValid,
      relocate: Boolean(scopeValid),
      reposition: Boolean(scopeValid)
    };
  }
  if (kind === 'added') return { cancelSettle: true, clearCache: true, reposition: true };
  return { ignore: true };
}

// Returns null when the window center is still on a connected display.
// Otherwise clamps onto the nearest display's work area (or an explicitly
// supplied display, such as screen.getDisplayNearest).
function relocateToVisibleDisplay(bounds, displays, nearest) {
  if (!bounds || !Array.isArray(displays) || !displays.length) return null;
  const center = windowCenter(bounds);
  if (displayForPoint(displays, center.x, center.y)) return null;
  const target = nearest || nearestDisplay(bounds, displays);
  const area = displayBounds(target);
  if (!area || area.width <= 0 || area.height <= 0) return null;
  const width = Math.round(Math.min(bounds.width, area.width));
  const height = Math.round(Math.min(bounds.height, area.height));
  const x = Math.round(Math.min(Math.max(bounds.x, area.x), area.x + area.width - width));
  const y = Math.round(Math.min(Math.max(bounds.y, area.y), area.y + area.height - height));
  return { x, y, width, height, displayId: target?.id ?? null, scaleFactor: scaleFactorOf(target) };
}

// Documents the supported call shape: null display hint, physical scope rect.
function dipAreaForScope(screenApi, scopeRect) {
  if (!scopeRect || !screenApi || typeof screenApi.screenToDipRect !== 'function') return null;
  return screenApi.screenToDipRect(null, scopeRect);
}

module.exports = {
  SCREEN_EVENT_DELAY_MS,
  scaleFactorOf,
  displayForPoint,
  displayForRect,
  crossedDisplay,
  noteDisplay,
  nearestDisplay,
  mergeScreenEvent,
  metricsNeedRelayout,
  planScreenEvent,
  relocateToVisibleDisplay,
  dipAreaForScope
};
