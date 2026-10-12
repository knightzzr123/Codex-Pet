'use strict';

// Coordinates are relative to the crop frame, independent of display DPI.
const CropGeometry = (() => {
  const limitZoom = value => Math.max(25, Math.min(400, Number(value) || 100));
  function frame(width, height, aspect) {
    const availableWidth = Math.max(1, width - 40);
    const availableHeight = Math.max(1, height - 40);
    const frameWidth = Math.min(availableWidth, availableHeight * aspect);
    return { width: frameWidth, height: frameWidth / aspect };
  }
  function placement(imageWidth, imageHeight, width, height, zoom, offset) {
    const scale = Math.min(width / imageWidth, height / imageHeight) * limitZoom(zoom) / 100;
    const drawnWidth = imageWidth * scale;
    const drawnHeight = imageHeight * scale;
    return { scale, width: drawnWidth, height: drawnHeight,
      x: (width - drawnWidth) / 2 + offset.x * width,
      y: (height - drawnHeight) / 2 + offset.y * height };
  }
  function constrain(imageWidth, imageHeight, width, height, zoom, offset) {
    const box = placement(imageWidth, imageHeight, width, height, zoom, { x: 0, y: 0 });
    const overlap = Math.min(12, box.width / 2, box.height / 2, width / 2, height / 2);
    return {
      x: Math.max((overlap - box.width - box.x) / width,
        Math.min((width - overlap - box.x) / width, offset.x)),
      y: Math.max((overlap - box.height - box.y) / height,
        Math.min((height - overlap - box.y) / height, offset.y))
    };
  }
  function zoomAt(imageWidth, imageHeight, width, height, previousZoom, nextZoom, offset, point) {
    const before = placement(imageWidth, imageHeight, width, height, previousZoom, offset);
    const after = placement(imageWidth, imageHeight, width, height, nextZoom, { x: 0, y: 0 });
    const sourceX = (point.x - before.x) / before.scale;
    const sourceY = (point.y - before.y) / before.scale;
    return constrain(imageWidth, imageHeight, width, height, nextZoom, {
      x: (point.x - sourceX * after.scale - after.x) / width,
      y: (point.y - sourceY * after.scale - after.y) / height
    });
  }
  function outputSize(aspect) {
    return aspect >= 1 ? { width: 768, height: Math.max(1, Math.round(768 / aspect)) }
      : { width: Math.max(1, Math.round(768 * aspect)), height: 768 };
  }
  return { limitZoom, frame, placement, constrain, zoomAt, outputSize };
})();

if (typeof module !== 'undefined') module.exports = CropGeometry;
