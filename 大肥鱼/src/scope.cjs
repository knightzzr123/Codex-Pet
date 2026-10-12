const { VIEWPORT } = require('./layout.cjs');
const EDGE_MARGIN = 2;
const SNAP_DISTANCE = 24;

function scopedBounds(rect, preferredScale = 0.8, placement = { right: 2, bottom: 2 }) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const scale = Math.min(preferredScale, (rect.width - 8) / VIEWPORT.width, (rect.height - 8) / VIEWPORT.height);
  if (scale < 0.35) return null;
  const width = Math.round(VIEWPORT.width * scale);
  const height = Math.round(VIEWPORT.height * scale);
  const right = Number.isFinite(placement.right) ? Math.max(2, Math.min(placement.right, rect.width - width - 2)) : 2;
  const bottom = Number.isFinite(placement.bottom) ? Math.max(2, Math.min(placement.bottom, rect.height - height - 2)) : 2;
  return { scale, bounds: {
    x: Math.round(placement.anchorX === 'left' ? rect.x + EDGE_MARGIN
      : rect.x + rect.width - width - (placement.anchorX === 'right' ? EDGE_MARGIN : right)),
    y: Math.round(placement.anchorY === 'top' ? rect.y + EDGE_MARGIN
      : rect.y + rect.height - height - (placement.anchorY === 'bottom' ? EDGE_MARGIN : bottom)), width, height
  } };
}

function snapBounds(rect, bounds, distance = SNAP_DISTANCE) {
  if (!rect || !bounds) return null;
  const left = rect.x + EDGE_MARGIN, top = rect.y + EDGE_MARGIN;
  const right = rect.x + rect.width - bounds.width - EDGE_MARGIN;
  const bottom = rect.y + rect.height - bounds.height - EDGE_MARGIN;
  if (right < left || bottom < top) return null;
  let x = Math.round(Math.max(left, Math.min(right, bounds.x)));
  let y = Math.round(Math.max(top, Math.min(bottom, bounds.y)));
  let anchorX = null, anchorY = null;
  // Choose the closest edge on each axis; snapping both axes also handles corners.
  if (Math.min(x - left, right - x) <= distance) {
    anchorX = x - left <= right - x ? 'left' : 'right';
    x = Math.round(anchorX === 'left' ? left : right);
  }
  if (Math.min(y - top, bottom - y) <= distance) {
    anchorY = y - top <= bottom - y ? 'top' : 'bottom';
    y = Math.round(anchorY === 'top' ? top : bottom);
  }
  return { bounds: { ...bounds, x, y }, placement: {
    right: Math.max(EDGE_MARGIN, rect.x + rect.width - x - bounds.width),
    bottom: Math.max(EDGE_MARGIN, rect.y + rect.height - y - bounds.height), anchorX, anchorY
  } };
}
function shouldShow(scope) {
  return scope?.active === true && scope?.ownerBound === true && Boolean(scope.rect);
}
module.exports = { scopedBounds, snapBounds, SNAP_DISTANCE, shouldShow };
