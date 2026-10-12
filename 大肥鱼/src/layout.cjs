const VIEWPORT = Object.freeze({ width: 360, height: 560 });

function inputRegions(scale, mirrored, bubbleVisible) {
  // Include the complete jump/stretch and bubble-follow envelope, plus fade-out.
  const regions = [{ x: mirrored ? 0 : 64, y: 232, width: 296, height: VIEWPORT.height - 232 }];
  if (bubbleVisible) regions.push({ x: 0, y: 0, width: VIEWPORT.width, height: 280 });
  return regions.map(rect => ({
    x: Math.floor(rect.x * scale), y: Math.floor(rect.y * scale),
    width: Math.ceil(rect.width * scale), height: Math.ceil(rect.height * scale)
  }));
}

module.exports = { VIEWPORT, inputRegions };
