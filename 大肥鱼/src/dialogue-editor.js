const $ = id => document.getElementById(id);
const { MAX_DIALOGUES, MAX_DIALOGUE_LENGTH, MAX_DIALOGUE_ROWS, fitDialogue } = globalThis.DafeiyuDialogue;
let draft, defaults, category = 'speech', selected = { speech: 0, sleepy: 0 }, saving = false;

function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function list() { return draft[category]; }
function updatePreview() {
  const text = $('line-text').value;
  $('preview-text').textContent = text || (list().length ? '在这里预览你写的台词。' : '这一类还没有台词。');
  fitDialogue($('preview-text'));
  const length = [...text.trim()].length;
  $('length').value = `${length} / ${MAX_DIALOGUE_LENGTH}`;
  $('length').classList.toggle('over-limit', length > MAX_DIALOGUE_LENGTH || text.trim().split('\n').length > MAX_DIALOGUE_ROWS);
}
function updateRow(index) {
  const row = $('line-list').children[index];
  if (row) {
    const text = list()[index];
    row.querySelector('.line-excerpt').textContent = text.trim().replace(/\s+/g, ' ') || '新台词（待填写）';
    row.title = text;
  }
}
function select(index, focus = false) {
  selected[category] = index;
  const exists = list().length > 0;
  for (const [rowIndex, row] of [...$('line-list').children].entries()) row.setAttribute('aria-pressed', String(rowIndex === index));
  $('text-label').textContent = exists ? `第 ${index + 1} 句` : '新增一句台词';
  $('line-text').disabled = !exists || saving;
  $('delete').disabled = !exists || saving;
  $('line-text').value = exists ? list()[index] : '';
  updatePreview();
  if (focus && exists) $('line-text').focus();
}
function renderList() {
  $('speech-count').textContent = draft.speech.length;
  $('sleepy-count').textContent = draft.sleepy.length;
  $('line-list').replaceChildren();
  const lines = list();
  if (!lines.length) {
    const empty = document.createElement('p'); empty.className = 'empty-list';
    empty.textContent = '还没有台词。点「新增」写下第一句吧。'; $('line-list').append(empty);
  } else lines.forEach((text, index) => {
    const row = document.createElement('button'); row.className = 'line-item';
    const number = document.createElement('span'); number.className = 'line-number'; number.textContent = String(index + 1).padStart(2, '0');
    const excerpt = document.createElement('span'); excerpt.className = 'line-excerpt';
    row.append(number, excerpt); row.addEventListener('click', () => select(index));
    $('line-list').append(row); updateRow(index);
  });
  $('add').disabled = saving || lines.length >= MAX_DIALOGUES;
  select(Math.min(selected[category], Math.max(0, lines.length - 1)));
}
function switchCategory(key) {
  category = key;
  for (const kind of ['speech', 'sleepy']) {
    $(kind + '-tab').setAttribute('aria-selected', String(kind === key));
    $(kind + '-tab').tabIndex = kind === key ? 0 : -1;
  }
  $('workspace').setAttribute('aria-labelledby', key + '-tab');
  $('list-title').textContent = key === 'speech' ? '日常台词' : '收尾台词';
  $('category-hint').textContent = key === 'speech' ? '点击气泡时，按列表顺序说下一句。' : '对话停留超时后说一句；删空这一类后，气泡直接收起。';
  renderList();
}
for (const kind of ['speech', 'sleepy']) {
  $(kind + '-tab').addEventListener('click', () => { if (draft && !saving) switchCategory(kind); });
  $(kind + '-tab').addEventListener('keydown', event => {
    if (!draft || saving || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'speech' : event.key === 'End' ? 'sleepy' : kind === 'speech' ? 'sleepy' : 'speech';
    switchCategory(next); $(next + '-tab').focus();
  });
}
$('line-text').addEventListener('input', () => {
  if (!draft || saving || !list().length) return;
  list()[selected[category]] = $('line-text').value;
  updateRow(selected[category]); updatePreview(); status('有修改尚未保存。保存后立即生效。');
});
$('add').addEventListener('click', () => {
  if (!draft || saving || list().length >= MAX_DIALOGUES) return;
  list().push(''); selected[category] = list().length - 1;
  renderList(); select(selected[category], true);
  $('line-list').lastElementChild?.scrollIntoView({ block: 'nearest' }); status('写好这句话，再保存吧。');
});
$('delete').addEventListener('click', () => {
  if (!draft || saving || !list().length) return;
  list().splice(selected[category], 1); renderList(); status('已从草稿删除这一句，保存后生效。');
});
$('restore').addEventListener('click', () => {
  if (!defaults || saving) return;
  draft = structuredClone(defaults); selected = { speech: 0, sleepy: 0 };
  switchCategory(category); status('已载入默认台词，保存后生效；取消会保留之前的台词。');
});
$('cancel').addEventListener('click', () => { if (!saving) window.dialogueEditorAPI.cancel(); });
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !saving) { event.preventDefault(); window.dialogueEditorAPI.cancel(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); $('save').click(); }
});
$('save').addEventListener('click', async () => {
  if (!draft || saving) return;
  saving = true; $('save').disabled = true; $('save').textContent = '正在保存…';
  for (const id of ['line-text', 'delete', 'add', 'restore', 'cancel']) $(id).disabled = true;
  try {
    const reply = await window.dialogueEditorAPI.save(draft);
    if (!reply?.ok) throw new Error(reply?.error || '保存失败，请重试。');
  } catch (error) {
    saving = false; $('save').disabled = false; $('save').textContent = '保存并应用';
    $('restore').disabled = false; $('cancel').disabled = false;
    renderList(); status(error.message, true);
  }
});
window.dialogueEditorAPI.getSource().then(source => {
  if (!source) throw new Error('无法读取台词，请关闭后重新打开。');
  draft = structuredClone(source.current); defaults = source.defaults;
  switchCategory('speech'); $('restore').disabled = false; $('save').disabled = false;
}).catch(error => status(error.message, true));
