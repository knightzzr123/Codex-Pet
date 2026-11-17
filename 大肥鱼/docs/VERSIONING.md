# 版本规则

大肥鱼有两个版本号，升版时一起改，并由 `test/version.test.cjs` 锁住内部版本。

| 名称 | 当前值 | 含义 |
|---|---|---|
| 展示版本 | `Codex-Pet-V1.4` | 面向 Release、README 和设置里“关于”页的标签 |
| 内部版本 | `3.4.0` | `package.json`、插件清单和 MCP `clientInfo` 使用的 semver |

## 怎么升

- 每个展示版 `V1.x` 升内部版本的次版本号，修订号归零。`V1.4` = `3.4.0`，`V1.5` = `3.5.0`。
- 同一个展示版里的热修复只升修订号，例如 `3.4.1`。不因此改展示标签。
- 展示标签使用连字符：`Codex-Pet-V1.4`。不要再用下划线，资产名也不要另起一套版本。

## 必须同步的位置

1. `package.json` 的 `version`
2. `plugin.json` 与 `.codex-plugin/plugin.json` 的 `version`
3. MCP `clientInfo.version`：`src/register-native-startup.cjs`、`src/startup-smoke.cjs`、`src/native-catalog-smoke.cjs`、`src/plugin-server.cjs`
4. `src/quota.cjs` 从 `package.json` 读取，不要再写死版本字面量
5. `tools/package.py` 的 `--version` 默认值

改完运行 `npm test`。`test/version.test.cjs` 会核对以上位置一致。

发版资产名沿用 `dafeiyu-codex-pet-<内部版本>-windows-x64.zip` 与 `dafeiyu-codex-pet-<内部版本>-source.zip`，并附带 `SHA256SUMS`。

`tools/package.py` 和 `tools/package-source.py` 只各写自己的 `<产物名>.sha256`（LF），不覆盖汇总文件。发版前由 `tools/write-sha256sums.py --version <内部版本> --complete <完整包> --source <源码包>` 一次生成含两个资产的 `SHA256SUMS`（LF），文件名使用上面的正式资产名。汇总脚本会读取两个 ZIP 内的 `PACKAGE-TYPE.json`，`--complete`/`--source` 写反时直接报错退出。

两个 ZIP 必须以上面的正式资产名放在 `SHA256SUMS` 同一目录，且解压后的 `大肥鱼\` 也在该目录下一层，`release-check --package` 才能按清单核对产物；推荐顺序是「解压 → 首次自检 → 汇总 → 再次自检」，两次自检都通过后再做最后一步真实解码回归（见下）。

## 发版前的真实解码回归

发版检查清单的最后一步：用打包附带的 Electron 跑一次 `test/electron/validate-skin-image.electron.cjs`，坏 PNG 必须被拒绝。该脚本需要 Electron 二进制，不在 `npm test` 里；它用生产版 `validateSkinImage` 对 `test/fixtures/skin-image/` 里的真实坏图跑 `createImageBitmap`，不是 mock。`runtime\electron.exe` 来自包里经 manifest 校验的 `runtime.7z`，而 `prepare-runtime.ps1` 解包成功后会删掉这个压缩包，所以在解压包的副本里跑，不要动发布目录里还要再自检的那一份。以下命令在 `大肥鱼\` 源码目录执行，`..\release\` 为发布目录：

```powershell
Copy-Item "..\release\大肥鱼" "$env:TEMP\dafeiyu-electron-check" -Recurse -Force
Set-Location "$env:TEMP\dafeiyu-electron-check"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\prepare-runtime.ps1 -Verify
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
.\runtime\electron.exe test\electron\validate-skin-image.electron.cjs
```

通过标准：退出码 0，最后一行是 `Electron <版本> / Chromium <版本>: 5 checks passed.`（Electron 版本应与 `runtime-manifest.json` 的 `electron` 一致），即 5 项全过：正常 PNG 能解码；`bad-idat`、`truncated-idat`、`truncated-file` 三张坏图都被拒绝并各写一条 `skin-pack-error`；渲染进程无响应时按 10 秒超时失败。出现 `ELECTRON SKIN DECODE TEST FAILED` 或退出码非 0 就不能发版。若 Electron 报 userData 不可写，追加 `--user-data-dir="$env:TEMP\dafeiyu-electron-test"`；整轮约需 10 秒以上。
