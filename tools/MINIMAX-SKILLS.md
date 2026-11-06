# MiniMax Skills（minimax-pdf）

给 Codex 和 Cursor 用的打印级 PDF 技能。不改变大肥鱼插件本身。

## 代理会在哪里找到技能

仓库里的副本不依赖家目录，云环境每次清空 `~` 之后仍然在：

- `.cursor/skills/minimax-pdf/`（Cursor 项目技能，含 `SKILL.md`）
- `.agents/skills/minimax-pdf` → 指向上面的目录（Codex 项目技能）

上游快照记录在 `.cursor/skills/minimax-pdf/UPSTREAM.md`。许可证是 MIT，见同目录 `LICENSE`。

## 本机官方安装

在代理或本机用户环境执行：

```bash
bash tools/install-minimax-skills.sh
```

脚本会：

1. 克隆或快进更新 `~/.codex/minimax-skills`
2. 建立 `~/.agents/skills/minimax-skills` → `~/.codex/minimax-skills/skills`
3. 建立 `~/.cursor/minimax-skills` → `~/.codex/minimax-skills`
4. 建立 `~/.cursor/skills/minimax-pdf` → 克隆里的 `minimax-pdf`
5. 安装 `reportlab`、`pypdf`、`matplotlib`，以及用户目录下的 Playwright Chromium
6. 运行 `bash scripts/make.sh check`

官方等价命令：

```bash
git clone https://github.com/MiniMax-AI/skills.git ~/.codex/minimax-skills
mkdir -p ~/.agents/skills
ln -sfn ~/.codex/minimax-skills/skills ~/.agents/skills/minimax-skills
```

Cursor 也可以把技能目录指到 `~/.cursor/minimax-skills/skills/`。这里用符号链接指向同一次克隆，避免再克隆一份。

## 检查

```bash
ls -la ~/.agents/skills/minimax-skills/minimax-pdf
cd ~/.codex/minimax-skills/skills/minimax-pdf && bash scripts/make.sh check
```

`check` 通过时期望看到 python3、reportlab、pypdf、node、playwright、matplotlib。家目录被清空后，先跑安装脚本再检查；技能说明文件本身以仓库副本为准。
