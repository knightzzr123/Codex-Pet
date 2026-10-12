const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const FORMATS = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' });

function imageFormat(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (bytes.toString('ascii', 0, 2) === 'BM') return 'bmp';
  return null;
}

function atomicWrite(file, contents) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents);
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function readImageFile(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('请选择图片文件。');
  if (stat.size > MAX_IMAGE_BYTES) throw new Error('图片不能超过 20 MB。');
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('图片不能超过 20 MB。');
  const extension = imageFormat(bytes);
  if (!extension) throw new Error('请使用 PNG、JPG、WebP、GIF 或 BMP 图片。');
  return { bytes, extension, mime: FORMATS[extension], name: path.parse(file).name.slice(0, 80) || '自定义皮肤' };
}

class SkinLibrary {
  constructor(dataDirectory) {
    this.directory = path.join(dataDirectory, 'skins');
    this.indexFile = path.join(this.directory, 'index.json');
    this.entries = [];
    try {
      const saved = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      const ids = new Set();
      if (saved.version === 1 && Array.isArray(saved.skins)) this.entries = saved.skins.filter(item => {
        if (!item || typeof item.id !== 'string' || !/^[a-f0-9]{64}$/.test(item.id)
          || typeof item.extension !== 'string' || !Object.hasOwn(FORMATS, item.extension)
          || typeof item.name !== 'string' || !item.name.trim() || ids.has(item.id)) return false;
        ids.add(item.id);
        return true;
      }).map(({ id, extension, name }) => ({ id, extension, name: name.slice(0, 80) }));
    } catch {}
  }

  list() {
    return this.entries.flatMap(entry => {
      // Never trust a stored path: asset names are derived from validated IDs.
      const file = path.join(this.directory, `${entry.id}.${entry.extension}`);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || !stat.size || stat.size > MAX_IMAGE_BYTES) return [];
      } catch { return []; }
      return [{ ...entry, file }];
    });
  }

  get(id) { return this.list().find(entry => entry.id === id) || null; }

  remove(id) {
    // Only a validated library ID can select a file inside our private store.
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) return false;
    const entry = this.entries.find(item => item.id === id);
    if (!entry) return false;
    const remaining = this.entries.filter(item => item.id !== id);
    atomicWrite(this.indexFile, JSON.stringify({ version: 1, skins: remaining }, null, 2));
    try {
      fs.unlinkSync(path.join(this.directory, `${entry.id}.${entry.extension}`));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // A locked or unwritable file must remain listed when removal fails.
        atomicWrite(this.indexFile, JSON.stringify({ version: 1, skins: this.entries }, null, 2));
        throw error;
      }
    }
    this.entries = remaining;
    return true;
  }

  async import(file, validateImage) {
    const { bytes, name } = readImageFile(file);
    return this.importBytes(bytes, name, validateImage);
  }

  async importBytes(bytes, name, validateImage) {
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('图片不能超过 20 MB。');
    const extension = imageFormat(bytes);
    if (!extension) throw new Error('请使用 PNG、JPG、WebP、GIF 或 BMP 图片。');
    // Decode before saving so a damaged or misleading file cannot replace the current skin.
    await validateImage(bytes, FORMATS[extension]);
    const id = createHash('sha256').update(bytes).digest('hex');
    const existing = this.get(id);
    if (existing && fs.readFileSync(existing.file).equals(bytes)) return existing;
    const entry = this.entries.find(item => item.id === id) || {
      id, extension, name: String(name || '自定义皮肤').slice(0, 80)
    };
    const entries = this.entries.filter(item => item.id !== id).concat(entry);
    fs.mkdirSync(this.directory, { recursive: true });
    // Preserve the original bytes, including transparency and GIF/WebP animation.
    atomicWrite(path.join(this.directory, `${id}.${extension}`), bytes);
    atomicWrite(this.indexFile, JSON.stringify({ version: 1, skins: entries }, null, 2));
    this.entries = entries;
    return this.get(id);
  }
}

module.exports = { SkinLibrary, MAX_IMAGE_BYTES, readImageFile, imageFormat };
