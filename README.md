# 大肥鱼 · Codex 角色插件

Windows 10/11 x64 本地角色插件，基于 3.4.0 项目持续维护。当前展示版本标签为 `Codex-Pet-V1.4`。

## 功能

- 点击人物查看 Codex 剩余额度，点击椭圆气泡继续中文对话。
- 鼠标和触摸拖动、边缘吸附、十档大小；气泡跟随人物移动和按压。
- 图片皮肤导入、缩放、裁剪、切换与删除；支持带 `manifest.json` 的多角色皮肤包文件夹和 ZIP。ZIP 里的 `__MACOSX`、`.DS_Store`、`Thumbs.db`、`.txt`、`.md`，以及没有扩展名的 `LICENSE` / `LICENCE` / `README` 会静默跳过；其它未知扩展名会拒绝整个包。
- 自定义台词，可编辑、新增和删除，保存后立即生效；点击与闲置触发带冷却/去重，不读取关键词或对话正文。
- 偏好导入/导出：只包含设置与皮肤清单，不打包图片、缩略图或自定义台词。
- 只读会话状态灯：Codex 忙碌/空闲/报错时显示不同文案与提示；报错气泡节流，探测失败按空闲降级，不读取对话正文。
- 设置面板按“外观 / 对话 / 行为 / 显示”分组，改动即时预览，支持单项、分组和“恢复默认”重置；透明度下限 0.35。
- 设置面板是键盘可达的模态对话框：焦点进入/返回、Tab 循环、读屏标签、系统高对比模式；低对比度导入皮肤仍受原图限制。
- 空闲期唤醒有明确预算并写入诊断：隐藏时暂停渲染 tick、会话探测 30 秒、插件轮询与 `runtime.json` 写盘降频。
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

诊断默认只读。需要修复安装类型标记、运行时解包或 Codex MCP 登记时：

```sh
node tools/diagnose.cjs --fix                 # 只打印修复计划；非交互环境需 --yes
node tools/diagnose.cjs --fix --yes           # 显式确认后执行
```

修复前会备份 Codex 配置（默认在数据目录 `backups/`），全程写入 `work/diagnose-repair-*.log`；不静默修改配置。运行时解包和 MCP 登记只在 Windows 完整安装包上可用。

发布前可运行文件系统级 Release 自检（不启动 Win GUI）：

```sh
npm run release-check
# 检查已解压的完整包；请先解压 ZIP
node tools/release-check.cjs --package "/path/to/解压后的完整包"
```

自检覆盖安装、卸载、升级保留设置/皮肤/台词三条路径，并校验 `PACKAGE-TYPE.json`、版本和 `FILES.sha256`。

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
python tools/package.py --original "完整安装包.zip" --output "..\大肥鱼-完整安装包.zip" --version 3.4.0
```

`--version` 默认值现已与源码对齐为 `3.4.0`，仍建议显式传入以免误用。`tools/package-source.py` 生成带 `PACKAGE-TYPE.json` 的源码包，不能当作完整安装包直接安装。完整包和源码包旁边都会写出 `SHA256SUMS`。完整安装包必须包含通过 `runtime-manifest.json` 校验的 `runtime.7z`。展示标签为 `Codex-Pet-V1.4`。

仓库保留源码、资源、测试和第三方许可证。运行时、安装包、用户数据和诊断文件由 `.gitignore` 排除；完整安装包作为 GitHub Releases 附件发布。

P1 实现说明与验证记录见 [docs/P1-NOTES.md](大肥鱼/docs/P1-NOTES.md)，P2 见 [docs/P2-NOTES.md](大肥鱼/docs/P2-NOTES.md)。

第三方组件说明见 [THIRD-PARTY-NOTICES.txt](大肥鱼/THIRD-PARTY-NOTICES.txt)，许可证保存在 `大肥鱼/licenses/` 和 `大肥鱼/tools/7zip/`。
