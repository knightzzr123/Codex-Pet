const fs = require('node:fs');
const path = require('node:path');
const { defaultDialogues, DialogueLibrary } = require('./dialogues.cjs');

module.exports = async function({ win, work, getMenu, chooseDialogueEditor,
  getDialogueEditorWindow, getDialogues, saveDialogues, dialogueFile }) {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const original = structuredClone(getDialogues()), checks = {}, errors = [];
  let editor, pending;
  const mainJS = code => win.webContents.executeJavaScript(code);
  const js = code => editor.webContents.executeJavaScript(code);
  const start = async () => {
    pending = chooseDialogueEditor();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      editor = getDialogueEditorWindow();
      if (editor && !editor.isDestroyed() && !editor.webContents.isLoading()
        && await js('Boolean(document.querySelector("#save") && !document.querySelector("#save").disabled)')) {
        editor.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
        return;
      }
      await wait(30);
    }
    throw new Error('台词编辑器未就绪');
  };
  const click = async selector => {
    const point = await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
      el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    editor.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    editor.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await wait(60);
  };
  const edit = text => js(`document.querySelector('#line-text').value = ${JSON.stringify(text)};
    document.querySelector('#line-text').dispatchEvent(new Event('input'));`);
  const layout = () => js(`(() => {
    const area = document.querySelector('.preview-area').getBoundingClientRect();
    const preview = document.querySelector('.preview-bubble').getBoundingClientRect();
    const footer = document.querySelector('footer').getBoundingClientRect();
    return document.querySelector('main').scrollWidth <= innerWidth && footer.bottom <= innerHeight
      && preview.top >= area.top - 1 && preview.bottom <= area.bottom + 1
      && preview.right <= innerWidth && preview.left >= 0;
  })()`);
  try {
    saveDialogues(original);
    checks.menuEntry = getMenu().items.some(item => item.label === '编辑台词…' && item.enabled);
    await start();
    checks.ownedModal = editor.getParentWindow() === win && editor.isModal() && !editor.isAlwaysOnTop();
    checks.initialContent = await js('draft.speech.length === 24 && draft.sleepy.length === 3 && document.querySelector("#line-text").value === draft.speech[0]');
    checks.defaultLayout = await layout();
    const bounds = editor.getBounds(); editor.setSize(600, 580); await wait(80);
    checks.compactLayout = await layout(); editor.setBounds(bounds); await wait(80);
    await edit('主人，摸摸我的尾鳍吧。');
    checks.previewUpdates = await js('document.querySelector("#preview-text").textContent === "主人，摸摸我的尾鳍吧。" && document.querySelector(".line-excerpt").textContent === "主人，摸摸我的尾鳍吧。"');
    await click('#add'); await edit('Hello 🐋 <b>主人</b>');
    checks.addsLine = await js('draft.speech.length === 25 && draft.speech.at(-1) === "Hello 🐋 <b>主人</b>"');
    await click('.line-item:nth-child(2)'); await click('#delete');
    checks.deletesExisting = await js('draft.speech.length === 24 && !draft.speech.includes("我是鲸鱼娘啦！看，我的小尾鳍会给你打气哦。")');
    await click('#sleepy-tab'); await edit('主人，晚安。');
    checks.editsSignOff = await js('draft.sleepy[0] === "主人，晚安。" && draft.speech[0] === "主人，摸摸我的尾鳍吧。"');
    await click('#add'); await click('#save');
    checks.blankRejected = !editor.isDestroyed() && await js('document.querySelector("#status").classList.contains("error") && !document.querySelector("#save").disabled');
    checks.invalidKeepsData = JSON.stringify(getDialogues()) === JSON.stringify(original)
      && JSON.stringify(JSON.parse(fs.readFileSync(dialogueFile, 'utf8'))) === JSON.stringify(original);
    await click('#delete'); await click('#save'); await pending;
    const custom = structuredClone(getDialogues());
    checks.savedAndReloaded = custom.speech[0] === '主人，摸摸我的尾鳍吧。' && custom.speech.at(-1) === 'Hello 🐋 <b>主人</b>'
      && custom.sleepy[0] === '主人，晚安。' && JSON.stringify(new DialogueLibrary(path.dirname(dialogueFile)).load()) === JSON.stringify(custom);
    checks.appliedToBubble = await mainJS(`(() => { speechIndex = 0; speak();
      return document.querySelector('#dialogue').textContent === '主人，摸摸我的尾鳍吧。' && document.querySelector('#quota-view').inert; })()`);
    checks.literalText = await mainJS(`(() => { speechIndex = speechLines.length - 1; speak();
      return document.querySelector('#dialogue').textContent === 'Hello 🐋 <b>主人</b>' && !document.querySelector('#dialogue b'); })()`);
    checks.customSignOff = await mainJS(`(() => { stopReading(); bubbleUntil = Date.now() - 1; sleepyReplyShown = false; tick();
      return document.querySelector('#dialogue').textContent === '主人，晚安。'; })()`);
    checks.longTextFits = await mainJS(`(() => {
      const el = document.querySelector('#dialogue');
      for (const line of ['鲸'.repeat(120), '鲸'.repeat(114) + '\\n一\\n二\\n三', 'W'.repeat(120)]) {
        setSpeech(line);
        if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) return false;
      }
      return true;
    })()`);
    await start(); await click('#restore');
    checks.restoreDraft = await js('draft.speech.length === 24 && draft.sleepy.length === 3 && draft.speech[0] !== "主人，摸摸我的尾鳍吧。"');
    await edit('这句不保存。'); await click('#cancel'); await pending;
    checks.cancelKeepsData = JSON.stringify(getDialogues()) === JSON.stringify(custom)
      && JSON.stringify(new DialogueLibrary(path.dirname(dialogueFile)).load()) === JSON.stringify(custom);
    await start();
    await js('while (!document.querySelector("#delete").disabled) document.querySelector("#delete").click();');
    await click('#sleepy-tab');
    await js('while (!document.querySelector("#delete").disabled) document.querySelector("#delete").click();');
    checks.emptyEditor = await js('draft.speech.length === 0 && draft.sleepy.length === 0 && document.querySelector("#line-text").disabled && !document.querySelector("#add").disabled');
    await click('#save'); await pending;
    checks.emptyPersists = getDialogues().speech.length === 0 && getDialogues().sleepy.length === 0
      && new DialogueLibrary(path.dirname(dialogueFile)).load().speech.length === 0;
    checks.emptyBubbleWorks = await mainJS(`(() => { speak(); const text = document.querySelector('#dialogue').textContent;
      stopReading(); bubbleUntil = Date.now() - 1; tick(); document.querySelector('#pet').click();
      return text.includes('编辑台词') && !document.querySelector('#quota-view').inert; })()`);
    await start(); await click('#restore');
    await js('new Promise(resolve => requestAnimationFrame(resolve))');
    fs.writeFileSync(path.join(work, 'dialogue-editor-preview.png'), (await editor.webContents.capturePage()).toPNG());
    await click('#save'); await pending;
    checks.restoresDefaults = JSON.stringify(getDialogues()) === JSON.stringify(defaultDialogues());
    checks.noConsoleErrors = errors.length === 0;
    return { checks, errors, pass: Object.values(checks).every(Boolean) };
  } finally {
    if (editor && !editor.isDestroyed()) editor.close();
    if (pending) await pending;
    saveDialogues(original);
    await mainJS('stopReading(); closeBubble(); speechIndex = 0; sleepyIndex = 0;');
  }
};
