const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_DIALOGUES, MAX_DIALOGUES, MAX_DIALOGUE_LENGTH, MAX_DIALOGUE_ROWS } = require('./dialogue-data.js');

function defaultDialogues() { return { speech: [...DEFAULT_DIALOGUES.speech], sleepy: [...DEFAULT_DIALOGUES.sleepy] }; }
function validateDialogues(value) {
  const result = {};
  for (const [key, label] of [['speech', '日常台词'], ['sleepy', '收尾台词']]) {
    if (!Array.isArray(value?.[key]) || value[key].length > MAX_DIALOGUES) throw new Error(`${label}最多保存 ${MAX_DIALOGUES} 句。`);
    result[key] = value[key].map((item, index) => {
      if (typeof item !== 'string') throw new Error(`${label}第 ${index + 1} 句需要填写文字。`);
      const text = item.replace(/\r\n?/g, '\n').trim();
      if (!text) throw new Error(`${label}第 ${index + 1} 句还没有内容，请填写或删除这一句。`);
      if ([...text].length > MAX_DIALOGUE_LENGTH) throw new Error(`${label}第 ${index + 1} 句超过 ${MAX_DIALOGUE_LENGTH} 字。`);
      if (text.split('\n').length > MAX_DIALOGUE_ROWS) throw new Error(`${label}第 ${index + 1} 句最多 ${MAX_DIALOGUE_ROWS} 行。`);
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error(`${label}第 ${index + 1} 句包含无法显示的字符。`);
      return text;
    });
  }
  return result;
}
class DialogueLibrary {
  constructor(dataDir, fsImpl = fs) { this.file = path.join(dataDir, 'dialogues.json'); this.fs = fsImpl; }
  load() {
    try { return validateDialogues(JSON.parse(this.fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''))); }
    catch { return defaultDialogues(); }
  }
  save(value) {
    const next = validateDialogues(value), temporary = this.file + '.tmp';
    this.fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try {
      this.fs.writeFileSync(temporary, JSON.stringify(next, null, 2), 'utf8');
      this.fs.renameSync(temporary, this.file);
    } catch (error) {
      try { this.fs.unlinkSync(temporary); } catch {}
      throw error;
    }
    return next;
  }
}
module.exports = { DialogueLibrary, defaultDialogues, validateDialogues };
