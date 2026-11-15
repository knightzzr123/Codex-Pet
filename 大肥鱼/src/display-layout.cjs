// Pure helpers for multi-monitor placement. Electron still converts the Codex
// client rect with screenToDipRect(null, …); these functions only decide which
// display that DIP rect lands on, and where to pull a window that lost its screen.

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

// Returns null when the window still intersects a connected display.
// Otherwise clamps it onto the primary work area so a removed monitor cannot
// leave the pet stranded off-screen.
function relocateToVisibleDisplay(bounds, displays) {
  if (!bounds || !Array.isArray(displays) || !displays.length) return null;
  if (displays.some(display => intersects(bounds, displayBounds(display)))) return null;
  const primary = displays.find(display => display.primary) || displays.find(display => display.internal) || displays[0];
  const area = displayBounds(primary);
  if (!area || area.width <= 0 || area.height <= 0) return null;
  const width = Math.round(Math.min(bounds.width, area.width));
  const height = Math.round(Math.min(bounds.height, area.height));
  const x = Math.round(Math.min(Math.max(bounds.x, area.x), area.x + area.width - width));
  const y = Math.round(Math.min(Math.max(bounds.y, area.y), area.y + area.height - height));
  return { x, y, width, height, displayId: primary.id ?? null, scaleFactor: scaleFactorOf(primary) };
}

// Documents the supported call shape: null display hint, physical scope rect.
function dipAreaForScope(screenApi, scopeRect) {
  if (!scopeRect || !screenApi || typeof screenApi.screenToDipRect !== 'function') return null;
  return screenApi.screenToDipRect(null, scopeRect);
}

module.exports = {
  scaleFactorOf,
  displayForPoint,
  displayForRect,
  crossedDisplay,
  noteDisplay,
  relocateToVisibleDisplay,
  dipAreaForScope
};
