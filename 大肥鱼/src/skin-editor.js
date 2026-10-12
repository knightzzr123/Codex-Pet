'use strict';
const $ = id => document.getElementById(id);
const canvas = $('preview'), stage = $('stage'), zoomInput = $('zoom');
const context = canvas.getContext('2d');
let image = null, zoom = 100, offset = { x: 0, y: 0 }, frame = { width: 1, height: 1 }, dragging = null, busy = false;

function aspectRatio() {
  const value = $('aspect').value;
  return value === 'pet' ? 258 / 250 : value === 'original' ? image.naturalWidth / image.naturalHeight : Number(value);
}
function draw() {
  if (!image) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.style.width = `${frame.width}px`;
  canvas.style.height = `${frame.height}px`;
  canvas.width = Math.max(1, Math.round(frame.width * ratio));
  canvas.height = Math.max(1, Math.round(frame.height * ratio));
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const box = CropGeometry.placement(image.naturalWidth, image.naturalHeight, frame.width, frame.height, zoom, offset);
  context.drawImage(image, box.x, box.y, box.width, box.height);
  zoomInput.value = String(zoom);
  $('zoom-value').value = `${zoom}%`;
}
function resize() {
  if (!image) return;
  frame = CropGeometry.frame(stage.clientWidth, stage.clientHeight, aspectRatio());
  offset = CropGeometry.constrain(image.naturalWidth, image.naturalHeight, frame.width, frame.height, zoom, offset);
  draw();
}
function changeZoom(value, point = { x: frame.width / 2, y: frame.height / 2 }) {
  if (!image || busy) return;
  const next = CropGeometry.limitZoom(Math.round(value));
  offset = CropGeometry.zoomAt(image.naturalWidth, image.naturalHeight, frame.width, frame.height, zoom, next, offset, point);
  zoom = next;
  draw();
}
function reset() { if (!image || busy) return; zoom = 100; offset = { x: 0, y: 0 }; resize(); }
function endDrag() {
  const previous = dragging;
  dragging = null;
  canvas.classList.remove('dragging');
  if (previous && canvas.hasPointerCapture(previous.id)) canvas.releasePointerCapture(previous.id);
}
canvas.addEventListener('pointerdown', event => {
  if (!image || busy || dragging || event.button !== 0 || !event.isPrimary) return;
  dragging = { id: event.pointerId, x: event.clientX, y: event.clientY, offset: { ...offset } };
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('dragging');
  event.preventDefault();
});
canvas.addEventListener('pointermove', event => {
  if (!dragging || event.pointerId !== dragging.id) return;
  offset = CropGeometry.constrain(image.naturalWidth, image.naturalHeight, frame.width, frame.height, zoom, {
    x: dragging.offset.x + (event.clientX - dragging.x) / frame.width,
    y: dragging.offset.y + (event.clientY - dragging.y) / frame.height
  });
  draw();
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, event => {
  if (dragging?.id === event.pointerId) endDrag();
});
window.addEventListener('blur', endDrag);
canvas.addEventListener('wheel', event => {
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  changeZoom(zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08), { x: event.clientX - rect.left, y: event.clientY - rect.top });
}, { passive: false });
canvas.addEventListener('keydown', event => {
  if (!image || busy || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const amount = event.shiftKey ? 20 : 5;
  offset = CropGeometry.constrain(image.naturalWidth, image.naturalHeight, frame.width, frame.height, zoom, {
    x: offset.x + (event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0) / frame.width,
    y: offset.y + (event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0) / frame.height
  });
  draw();
});
zoomInput.addEventListener('input', () => changeZoom(Number(zoomInput.value)));
$('zoom-out').addEventListener('click', () => changeZoom(zoom - 10));
$('zoom-in').addEventListener('click', () => changeZoom(zoom + 10));
$('reset').addEventListener('click', reset);
$('aspect').addEventListener('change', reset);
new ResizeObserver(resize).observe(stage);

async function finish(mode) {
  if (busy || (mode !== 'cancel' && !image)) return;
  $('status').textContent = '';
  let dataUrl;
  if (mode === 'crop') {
    const size = CropGeometry.outputSize(aspectRatio());
    const output = document.createElement('canvas');
    output.width = size.width; output.height = size.height;
    const ctx = output.getContext('2d');
    const box = CropGeometry.placement(image.naturalWidth, image.naturalHeight, frame.width, frame.height, zoom, offset);
    const sx = size.width / frame.width, sy = size.height / frame.height;
    ctx.drawImage(image, box.x * sx, box.y * sy, box.width * sx, box.height * sy);
    const pixels = ctx.getImageData(0, 0, size.width, size.height).data;
    let visible = false;
    for (let index = 3; index < pixels.length; index += 4) { if (pixels[index]) { visible = true; break; } }
    if (!visible) { $('status').textContent = '裁剪区域没有可见内容，请将图片移回框内。'; return; }
    dataUrl = output.toDataURL('image/png');
  }
  busy = true;
  endDrag();
  for (const control of document.querySelectorAll('button, input, select')) control.disabled = true;
  try {
    const result = await window.skinEditorAPI.finish({ mode, dataUrl });
    if (!result?.ok) throw new Error(result?.error || '保存失败，请重试。');
  } catch (error) {
    busy = false;
    for (const control of document.querySelectorAll('button, input, select')) control.disabled = false;
    $('status').textContent = error.message;
  }
}
$('save').addEventListener('click', () => finish('crop'));
$('original').addEventListener('click', () => finish('original'));
$('cancel').addEventListener('click', () => finish('cancel'));
window.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); finish('cancel'); } });

(async () => {
  try {
    const source = await window.skinEditorAPI.getSource();
    if (!source) throw new Error('无法读取图片，请重新导入。');
    $('filename').textContent = source.name;
    $('animation-note').hidden = !source.mayAnimate;
    const loaded = new Image();
    await new Promise((resolve, reject) => {
      loaded.onload = resolve;
      loaded.onerror = () => reject(new Error('这张图片无法显示，请换一张图片。'));
      loaded.src = source.dataUrl;
    });
    image = loaded;
    resize();
    $('original').disabled = false;
    $('save').disabled = false;
  } catch (error) { $('status').textContent = error.message; $('filename').textContent = '图片载入失败'; }
})();
