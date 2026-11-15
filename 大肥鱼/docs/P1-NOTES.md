# Codex-Pet P1 实现说明（V1.2 之后）

范围：会话态可视化、设置面板 IA 2.0、一键诊断与修复、Release 自检。未提升内部版本、未打标签、未合并 main、未发布。皮肤包规范、多角色等留给 P2。

## 1. 会话态可视化

### 通道结论

Codex 没有稳定、公开的“忙碌/空闲/报错”事件契约。本轮先做**只读、best-effort** 探测，不读取对话正文，也不向 Codex 写入任何状态：

- `~/.codex/sessions/**/rollout-*.jsonl`：只 `stat` 最新 rollout 的 `mtimeMs`/`size`，**不打开、不解析正文**。mtime 在 4.5 秒内视为忙碌。
- `~/.codex/logs_*.sqlite`：只查询 `select max(ts) from logs where level = 'ERROR'`，**不读取 `feedback_log_body`、thread 标题、prompt 或 preview**。最近 60 秒的 ERROR 视为报错。
- 如果两个来源都不可用、查询抛错或权限不足：状态直接降级为 `idle`，`degraded=true`，不崩溃；错误只写日志，不影响拖拽、设置和额度刷新。

本机 Linux 环境实测：`rollout-mtime` 通道可用；SQLite 日志在只读打开时可能因 WAL/权限不可用，因此错误检测是实验性的。Windows 实机仍需验证 Codex 版本升级、日志库命名和锁行为。

### 映射与节流

- 5 秒轮询一次，状态变化才推送渲染层；状态快照同时写 `work/session-state.json` 供诊断引用。
- 状态文案：`idle`=空闲、`busy`=忙碌中、`error`=出错了；人物旁显示小状态点/文案。
- 报错气泡由主进程节流：首次出现一次，持续报错最多每 60 秒再提示一次；气泡 `pointer-events:none`，不会挡住拖拽或设置。
- 探测不可用时按空闲显示，并带 `状态探测不可用` 的提示标题。

测试：`test/session-state.test.cjs` 覆盖探测抛错、通道不可用、忙碌超时、报错节流、rollout 只读元数据、日志库异常降级。

## 2. 设置面板 IA 2.0

- 分组：**外观**（皮肤/大小）、**对话**（台词/停留/点人物继续/气泡偏移）、**行为**（闲置间隔/贴左转向/减少动画）、**显示**（透明度）。
- 即时预览：滑条和开关改动立刻发送到主进程，同时先更新本地 CSS 变量；皮肤/大小沿用原有即时切换。
- 重置：每个分组有“重置本组”，每个可重置项有单项 `↺`，底部有“恢复默认”。
- “恢复默认”只重置可调设置；保留窗口位置、自定义台词内容和已导入皮肤（不删除用户文件）。透明度重置为 1，运行时仍保持 0.35 下限。
- 兼容：沿用 `settings.json` 现有键，不新增必填字段；旧版 `idleInterval`、缺失字段和非法值仍走 `experienceFromPreferences` 的默认/钳制逻辑。
- 主进程新增 `pet:reset-setting`、`pet:reset-group`、`pet:reset-all`；重置逻辑在 `src/settings-ia.cjs`，便于单测。

测试：`test/settings-ia.test.cjs` 覆盖分组、单项/分组/全部重置、保留位置与台词、默认值幂等，以及面板/主进程接线。

## 3. 一键诊断与修复

默认命令仍只读：

```sh
npm run diagnose
node tools/diagnose.cjs --root "/path/to/大肥鱼"
```

默认诊断只读检查包类型、必需文件、版本、runtime manifest/hash、诊断产物和 Codex MCP 登记；不写文件、不修改 Codex 配置。

修复需要显式确认：

```sh
node tools/diagnose.cjs --fix          # 只打印计划；非交互环境会要求 --yes
node tools/diagnose.cjs --fix --yes    # 显式确认后执行
```

修复项：

- **安装**：完整包缺 `PACKAGE-TYPE.json` 时按已校验 runtime 补写；源码树通常不带该标记，视为正常；缺必需文件时拒绝伪造，提示重新解压。
- **运行时**：Windows 完整包缺 `runtime/electron.exe` 时，先校验 `7zr.exe` 与 `runtime.7z` 哈希，再沙箱解包、校验后替换；现有不完整目录会先改名备份。
- **MCP 登记**：先备份 `%USERPROFILE%\.codex\config.toml`（或 `CODEX_HOME` 下同名文件）到数据目录 `backups/`，再用官方 app-server 登记 `codex-pet`；失败自动回滚配置。

全程写 `work/diagnose-repair-<timestamp>.log`；幂等，已正确项跳过。Linux 不能运行 Windows 的 `7zr.exe`，所以运行时/MCP 修复在 Linux 上显示为“需在 Windows 执行”。

测试：`test/diagnose.test.cjs`（原有只读行为）、`test/diagnose-repair.test.cjs`（计划、确认、备份、回滚、运行时动作）。

## 4. Release 自检

```sh
npm run release-check
node tools/release-check.cjs --package "/path/to/解压后的完整包"
node tools/release-check.cjs --package "/path/..." --report report.json
```

自检用夹具/临时目录做**文件系统级**验收，不启动 Win GUI：

- **安装**：复制完整包、检查 `PACKAGE-TYPE.json`/版本/`FILES.sha256`，创建用户设置/皮肤/台词夹具。
- **卸载**：只删除安装目录，断言用户数据快照逐字节不变。
- **升级**：先装旧包，覆盖新包，断言版本变化、用户数据仍不变。
- 负向：源码包/被篡改包不能通过；模拟卸载误删用户数据会被判失败。

Windows GUI、真实安装器、Codex marketplace/MCP 和 95MB runtime 的端到端行为仍需在 Windows 上验收；本环境只跑 Node 测试。

## 测试结果（本机 Linux，2026-11-16）

- `cd 大肥鱼 && npm test`：**107 pass / 0 fail**（含新增 session/settings/diagnose-repair/release-check 测试）。
- `npm run release-check`：exit 0，install/uninstall/upgrade 均为 PASS。
- `npm run diagnose`：只读，exit 0（源码树；源码树无 runtime 为正常警告）。
- `env -u GIT_CONFIG_COUNT -u GIT_CONFIG_VALUE_0 python3 -m unittest test/test_package_type.py -v`：8 pass / 0 fail（未改 Python 打包逻辑；本环境 shell 的 git 配置缺键，需去掉这两个变量）。

## 未做 / 留给 P2

皮肤包本地导入规范、多角色、台词触发规则、偏好导入导出、性能待机、无障碍补齐、多显示器/DPI、自动更新、语音/跨平台/主题商店，以及任何对 Codex 的反向控制或输入注入。未重做 #2/#3 动效；未 bump 版本、未打 tag、未发版。

## P2 说明

P2（皮肤包与多角色、台词触发、偏好导入导出、性能待机、无障碍）见 [P2-NOTES.md](P2-NOTES.md)；两份说明交叉链接，P1 的会话态/设置/诊断/释放自检行为未改变。
