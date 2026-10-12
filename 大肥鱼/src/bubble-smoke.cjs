const fs = require('node:fs');
const path = require('node:path');
const { inputRegions } = require('./layout.cjs');

module.exports = async function runBubbleSmoke({ win, work, getPreferences, setPlacement,
  dragStart, dragMove, dragEnd }) {
  const originalPlacement = structuredClone(getPreferences().placement);
  const js = source => win.webContents.executeJavaScript(source);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const orientations = [];
  const snapshot = () => js(`({
    bubble: document.querySelector('#bubble').getBoundingClientRect().toJSON(),
    pet: document.querySelector('#pet').getBoundingClientRect().toJSON()
  })`);
  try {
    for (const mirrored of [false, true]) {
      setPlacement({ ...originalPlacement, anchorX: mirrored ? 'left' : 'right' });
      await js(`(() => { stopReading(); speak(); bubbleUntil = Infinity;
        cancelPetMotion(); document.querySelector('#pet').blur(); })()`);
      await wait(400);
      const region = inputRegions(win.webContents.getZoomFactor(), mirrored, true)[1];
      const geometry = await js(`(() => {
        playReaction(); petAnimation.pause(); bubbleFollowAnimation.pause(); reactionAnimation?.cancel();
        const bubble = document.querySelector('#bubble'), image = document.querySelector('#pet-image');
        const poses = [];
        for (let time = 0; time <= 760; time += 19) {
          petAnimation.currentTime = time; bubbleFollowAnimation.currentTime = time;
          const bubbleRect = bubble.getBoundingClientRect(), imageRect = image.getBoundingClientRect();
          const hit = document.elementFromPoint(bubbleRect.left + bubbleRect.width / 2, bubbleRect.bottom - 20);
          poses.push({ time, gap: imageRect.top - bubbleRect.bottom,
            bubble: bubbleRect.toJSON(),
            readable: Boolean(hit?.closest('#bubble')) });
        }
        const peak = poses.reduce((a, b) => a.gap < b.gap ? a : b);
        petAnimation.currentTime = peak.time; bubbleFollowAnimation.currentTime = peak.time;
        return { poses, peak,
          compresses: poses.some(pose => pose.bubble.height < poses[0].bubble.height * .86),
          follows: poses.some(pose => Math.abs(pose.bubble.top - poses[0].bubble.top) > 4),
          layer: Number(getComputedStyle(document.querySelector('#speech-anchor')).zIndex)
            > Number(getComputedStyle(document.querySelector('#pet')).zIndex) };
      })()`);
      const scale = win.webContents.getZoomFactor();
      const covered = geometry.poses.every(({ bubble }) => bubble.left * scale >= region.x - 1
        && bubble.top * scale >= region.y - 1 && bubble.right * scale <= region.x + region.width + 1
        && bubble.bottom * scale <= region.y + region.height + 1);
      orientations.push({ mirrored, minimumGap: geometry.peak.gap, follows: geometry.follows,
        separated: geometry.poses.every(pose => pose.gap >= 10),
        readable: geometry.poses.every(pose => pose.readable), nativeRegionCoversAnimation: covered,
        foregroundLayer: geometry.layer, compresses: geometry.compresses });

      await js('cancelPetMotion(); document.body.classList.add("pressing")');
      await wait(130);
      const press = await js(`(() => {
        const pet = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('#pet-image')).transform);
        const bubble = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('#speech-anchor')).transform);
        return { synchronized: Math.abs(pet.d - bubble.d) < .005 && bubble.d < .9,
          bubble: document.querySelector('#bubble').getBoundingClientRect().toJSON() };
      })()`);
      orientations.at(-1).pressSynchronized = press.synchronized;
      orientations.at(-1).pressCovered = press.bubble.left * scale >= region.x - 1
        && press.bubble.right * scale <= region.x + region.width + 1
        && press.bubble.top * scale >= region.y - 1
        && press.bubble.bottom * scale <= region.y + region.height + 1;
      await js('document.body.classList.remove("pressing")');
      await wait(130);
      fs.writeFileSync(path.join(work, `bubble-follow-${mirrored ? 'left' : 'right'}.png`),
        (await win.webContents.capturePage()).toPNG());
    }

    // A shared native window must carry both parts by the same screen-space delta.
    setPlacement({ right: 100, bottom: 100, anchorX: null, anchorY: null });
    await js('cancelPetMotion(); bubbleUntil = Infinity; render()');
    await wait(300);
    const before = await snapshot(), beforeWindow = win.getBounds();
    dragStart({ x: 0, y: 0 }); dragMove({ x: -48, y: -32 });
    const after = await snapshot(), afterWindow = win.getBounds();
    const scale = win.webContents.getZoomFactor();
    const delta = part => ({
      x: afterWindow.x - beforeWindow.x + (after[part].left - before[part].left) * scale,
      y: afterWindow.y - beforeWindow.y + (after[part].top - before[part].top) * scale
    });
    const bubbleDelta = delta('bubble'), petDelta = delta('pet');
    dragEnd();
    const followsDrag = Math.abs(bubbleDelta.x - petDelta.x) <= 1
      && Math.abs(bubbleDelta.y - petDelta.y) <= 1 && Math.abs(bubbleDelta.x) > 20 && Math.abs(bubbleDelta.y) > 20;

    const hit = await snapshot();
    const x = Math.round((hit.bubble.left + hit.bubble.width / 2) * scale);
    const y = Math.round((hit.bubble.top + hit.bubble.height / 2) * scale);
    const previousLine = await js('document.querySelector("#dialogue").textContent');
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await wait(100);
    const bubbleClickable = await js(`document.querySelector('#dialogue').textContent !== ${JSON.stringify(previousLine)}
      && !document.querySelector('#dialogue-view').inert && document.querySelector('#quota-view').inert`);
    return { orientations, followsDrag, bubbleDelta, petDelta, bubbleClickable,
      pass: followsDrag && bubbleClickable && orientations.every(item => item.follows && item.separated
        && item.readable && item.nativeRegionCoversAnimation && item.foregroundLayer && item.compresses
        && item.pressSynchronized && item.pressCovered) };
  } finally {
    await js('cancelPetMotion(); document.body.classList.remove("pressing"); reactionAnimation?.cancel(); stopReading(); closeBubble()');
    setPlacement(originalPlacement);
  }
};
