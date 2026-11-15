# 大肥鱼 · Codex 角色插件

Windows 10/11 x64 本地角色插件，基于 3.3.1 项目持续维护。计划中的展示版本标签为 `Codex-Pet-V1.2`（尚未打标签，也尚未发布 GitHub Release）。

## 功能

- 点击人物查看 Codex 剩余额度，点击椭圆气泡继续中文对话。
- 鼠标和触摸拖动、边缘吸附、十档大小；气泡跟随人物移动和按压。
- 图片皮肤导入、缩放、裁剪、切换与删除。
- 自定义台词，可编辑、新增和删除，保存后立即生效。
- 绑定 Codex 原生窗口，切换其他应用时保留，最小化时隐藏；由 Codex 原生 MCP 服务加载。

## 安装与使用

1. 完整解压安装包，双击包内的 **安装大肥鱼.cmd**。
2. 在 Codex 插件页面启用“大肥鱼”，然后重新打开 Codex。
3. 右键人物调整大小、皮肤和台词；额度与对话通过点击查看。

发行物分为两种：**源码包**只含源码和资源，不含运行时，不能作为完整安装包直接安装；**Win64 完整安装包**包含匹配的运行时，可按上述步骤安装。源码目录使用 `install.cmd`。
此插件需要本机 Windows 程序；Codex 的 ZIP 上传入口不会执行本地安装器。

设置、皮肤和台词保存在 `%LOCALAPPDATA%\DafeiyuCodexPet`，更新保留这些数据。
停用插件会停止人物；卸载后可执行 `codex mcp remove codex-pet` 清理默认 MCP 登记。

## 开发与验证

运行只读诊断（默认不写文件）：

```sh
npm run diagnose
# 或指定插件根目录
node tools/diagnose.cjs --root "/path/to/大肥鱼"
```

源码仓库不包含 Electron 二进制。从完整安装包复制 `runtime.7z` 到项目根目录，然后执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\prepare-runtime.ps1 -Verify
npm test
```

单元测试需要 Node.js 22.12+。交互修改还需使用准备好的运行时执行 GUI 检查：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
.\runtime\electron.exe . --smoke-test
```

## 打包与发布

打包需要 Python 3.11+，可从已有完整安装包复用经过校验的运行时：

```powershell
python tools/package.py --original "完整安装包.zip" --output "..\大肥鱼-完整安装包.zip" --version 3.3.1
```

`--version` 默认值现已与源码对齐为 `3.3.1`，仍建议显式传入以免误用。`tools/package-source.py` 生成带 `PACKAGE-TYPE.json` 的源码包，不能当作完整安装包直接安装。完整安装包必须包含通过 `runtime-manifest.json` 校验的 `runtime.7z`。展示标签若发布，应使用 `Codex-Pet-V1.2`。

仓库保留源码、资源、测试和第三方许可证。运行时、安装包、用户数据和诊断文件由 `.gitignore` 排除；完整安装包作为 GitHub Releases 附件发布。

第三方组件说明见 [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt)，许可证保存在 `licenses/` 和 `tools/7zip/`。
