# Codex-Pet P2 实现说明（V1.2 之后）

P1 见 [P1-NOTES.md](P1-NOTES.md)。本轮在 `feat/p1-p2-v13` 上继续实现 P2：皮肤包与多角色、台词触发规则、偏好导入导出、性能待机、无障碍。未重做 #2/#3 动效。发布准备：内部版本提升为 3.3.2，展示标签 `Codex-Pet-V1.3`。

## 1. 皮肤包本地导入与多角色切换

### manifest v1

皮肤包是**本地文件夹**（当前不支持 ZIP），选择包含 `manifest.json` 的文件夹导入。manifest 版本由 `src/manifests.cjs` 统一为 `1`；偏好文件也使用同一版本号，避免两套格式漂移。

```json
{
  "manifestVersion": 1,
  "id": "demo-pack",
  "name": "示例皮肤包",
  "version": "1.0.0",
  "store": { "version": 1 },
  "characters": [
    {
      "id": "whale",
      "name": "鲸鱼娘",
      "image": "images/whale.png",
      "thumbnail": "thumbnails/whale.png"
    },
    {
      "id": "rose",
      "name": "玫瑰",
      "image": "images/rose.webp"
    }
  ]
}
```

规则：

- `manifestVersion` 必须是整数 `1`；更高版本直接拒绝，并提示“版本不支持”。
- `name` 必填；`characters` 1–12 个；角色 `id` 必需且包内唯一（字母、数字、下划线、短横线）。
- `image`/`thumbnail` 必须是包内相对路径；拒绝绝对路径、盘符、`..`、符号链接和跳出目录。
- 角色图片沿用现有单图皮肤限制：PNG/JPG/WebP/GIF/BMP，单张 ≤20 MB；导入前用 Chromium 实际解码验证，损坏图片不会覆盖当前皮肤。
- `store` 仅保留 `version: 1` 字段，本版本不下载、不校验、不请求任何商店/支付/审核接口。
- **缩略图规格**：可选；有则必须是 PNG/JPG/WebP、正方形、边长 64–256 像素、≤512 KB，并实际解码验证。缺省时 UI 回退使用角色图片作为预览。
- 失败回滚：先在 `.staging-*` 暂存目录写完全部文件，再原子改名到内容寻址目录 `skin-packs/<sha256>/`；索引写入失败时删除新目录并保留旧索引；任何一步失败都不留下半成品或半更新索引。

兼容性：

- 原有单图皮肤库 `skins/index.json`（version 1）和 `skins/` 目录完全不变，继续可导入、切换、删除。
- 皮肤包放在独立的 `skin-packs/` 目录，不会改写旧索引。皮肤包内文件复制为受控文件名，索引只保存受控文件名，不信任 manifest 里的路径。
- `settings.json` 的 `skinId` 字段继续复用：旧值 `default`、`rose`、64 位图片哈希照常工作；皮肤包角色使用稳定的 `pack:<packId>:<characterId>`。
- 多角色切换只改 `preferences.skinId` 并复用同一个 `BrowserWindow` 和现有生命周期；主进程仍由 `requestSingleInstanceLock()` 保证单实例，不新增窗口、不重复抢 Codex 绑定。
- 皮肤包可在右键菜单“删除导入皮肤 → 皮肤包”中整体删除；删除当前角色所在包会回到默认角色。

接线：`src/skin-packs.cjs`、`src/manifests.cjs`、`src/main.cjs`、`src/preload.cjs`、`src/index.html`、`src/renderer.js`、`src/style.css`。测试：`test/skin-packs.test.cjs`（manifest 版本/路径/缩略图、去重、回滚、删除、旧皮肤兼容、单实例接线）。

## 2. 台词触发规则

`src/dialogue-triggers.js` 是纯函数/状态机，渲染层只传显式 `click` 或 `idle`：

- **点击**：按顺序循环，相邻不重复同一句；空台词给出“编辑台词”提示，不影响额度面板。
- **闲置**：无交互时间达到 `idleIntervalSec`（下限 5 秒，沿用现有设置项）后才可能触发；气泡已打开、设置面板打开、拖动、减少动画开启时不触发。
- **冷却/去重**：闲置台词默认 5 分钟冷却（`IDLE_COOLDOWN_MS`），且不连续重复同一句；单句台词第二次闲置会直接跳过，避免刷屏。
- **依赖会话态**：`busy`/`error` 时不自动说闲置台词（报错气泡仍由 P1 的 60 秒节流负责）；点击不受影响。
- **隐私边界**：没有关键词匹配、剪贴板、输入框或对话正文读取；测试 `test/dialogue-triggers.test.cjs` 明确断言未知触发（包括 `keyword`）被拒绝，渲染层没有窗口级 `keypress`/`input` 关键词监听。

接线：`src/index.html` 加载 `dialogue-triggers.js`；`src/renderer.js` 的 `speak('idle')` 与 `maybeIdleAction()`；台词更新后 `dialogueTrigger.reset()`。

## 3. 偏好导入/导出

`src/preferences-bundle.cjs` 定义 `dafeiyu.preferences` 文件，`manifestVersion` 与皮肤包同为 1。

- 导出白名单：`skinId`、`sizeLevel`、`bubbleSeconds`、`advanceOnPetTap`、`mirrorOnLeft`、`reducedMotion`、`bubbleOffsetX/Y`、`idleIntervalSec`、`opacity`，以及皮肤/角色的 `id`、`name`、`kind` 清单。
- **不导出**：任何图片/缩略图字节、`data:` URL、本地文件路径、窗口位置 `placement`、自定义台词 `dialogues`、`runtime.json`/额度缓存等运行数据。
- 导入时重新走 `experienceFromPreferences` 和 `sizeLevelFromPreferences` 钳制；忽略白名单外字段；本机不存在的皮肤回退 `default` 并提示。文件上限 256 KB，仍是普通 JSON，不执行其中任何代码。
- 边界与 manifest 对齐：两者共用 `src/manifests.cjs` 的版本常量，测试断言版本一致；导入皮肤包和导入偏好都不会打包用户图片本体。

接线：设置面板“数据”分组、`pet:export-preferences`/`pet:import-preferences`、preload 两个方法。测试：`test/preferences-bundle.test.cjs`。

## 4. 性能与待机

### 预算（写入 `src/idle-budget.js`，并进入诊断报告）

| 项 | 预算/取值 | 说明 |
| --- | --- | --- |
| 空闲 CPU | **<1%**（60 秒平均，Windows 实机目标） | 本环境无 GUI/Windows 运行时，无法给出真实 CPU 百分比；以唤醒次数、跳过渲染计数和诊断字段作为可验证契约 |
| 渲染层 tick | 1000 ms | 气泡倒计时需要；空闲且无待办时跳过 DOM，`document.hidden` 时停表 |
| 会话探测 | 可见 5000 ms / 隐藏 30000 ms | 忙碌判定窗 4.5 秒，可见时不能慢于 5 秒；隐藏时无需 5 秒 |
| 插件存活轮询 | 3000 ms | 原 1500 ms；启动宽限仍为 30 秒 |
| `runtime.json` 写入 | ≤ 每 30000 ms 一次 | 原每次轮询都写，现单独节流 |
| 额度刷新 | 120000 ms | 保持不变 |
| scope 子进程心跳 | 2000 ms | 原 1000 ms；输出超时仍按 5 秒判定 |

### 落地改动

- 主进程会话探测由固定 `setInterval(5000)` 改为递归 `setTimeout`：可见 5 秒、隐藏 30 秒，隐藏→可见时立即补一次；`before-quit` 清理定时器。
- 插件存活轮询 1500→3000 ms；`saveRuntime()` 只在距上次写入 ≥30 秒时执行。
- 渲染层仍保留 1 秒 tick 以兼容现有测试与气泡倒计时，但 `rendererTickPlan()` 判定无气泡、无设置、无加载、未到闲置动作时直接返回，不执行 `render()`/`maybeIdleAction()`；`idleTicksSkipped` 记录跳过次数。窗口隐藏时清除 interval，恢复可见时重建。
- scope 心跳 1000→2000 ms，5 秒无输出仍会重启子进程。
- 启动时写 `work/idle-budget.json`（预算、当前可见性、实际探测/轮询间隔）；`npm run diagnose` 的 `checks.idleBudget` 直接输出同一份常量，并登记该产物。

测试：`test/idle-budget.test.cjs` 断言预算常量、可见/隐藏探测间隔、30 秒写盘阈值、渲染层跳过/唤醒条件，以及 main/renderer/scope-monitor/diagnose 的接线不回退。

## 5. 无障碍

- 设置面板改为 `role="dialog"` + `aria-modal="true"`，由 `settings-title`/`settings-intro` 命名和描述；打开后焦点进入关闭按钮，Esc/关闭后回到打开前的控件（通常是角色），Tab/Shift+Tab 在面板内循环。
- 所有滑条补 `aria-label`；气泡停留秒数、大小按钮补 `role="radio"` + `aria-checked`；皮肤按钮补 `role="radio"`、`aria-checked`/`aria-pressed` 和“当前角色/切换到”读屏名称；缩略图 `alt=""` 且 `aria-hidden`，避免重复朗读。
- 高对比不只改变量：`@media (forced-colors: active)` 使用系统色 `Canvas`/`CanvasText`/`ButtonFace`/`ButtonText`/`Highlight`/`HighlightText`，给气泡、设置面板、会话状态加真实边框，焦点环使用 `Highlight`；`@media (prefers-contrast: more)` 加粗边框、加深次要文字。
- **皮肤对比度限制**：角色图是用户导入的位图，应用无法安全地重绘或自动调色；高对比模式下 `#pet-image` 保留原图（`forced-color-adjust: none`），因此低对比度皮肤仍可能看不清角色轮廓。文字气泡、设置面板、状态点不依赖皮肤颜色。需要极致对比时请使用默认角色或高对比度皮肤图。
- 减动效已随 PR#1/“减少动画”设置项落地，本轮不重复立项；本轮只确保新增的对话框焦点/标签/高对比不与它冲突。

测试：`test/accessibility.test.cjs`（对话框语义、焦点返回、Tab 循环、标签/单选语义、forced-colors 与皮肤限制说明）。

## 测试结果（本机 Linux，2026-11-16）

- `cd 大肥鱼 && npm test`：**138 pass / 0 fail**（原有 107 项 + 新增 31 项：skin-packs 10、dialogue-triggers 6、preferences-bundle 6、idle-budget 4、accessibility 5）。
- `npm run diagnose`：只读，exit 0；`checks.idleBudget` 输出上表预算。
- 未改发布版本、未打 tag、未 merge main、未发版；未提交 `work/`。
- Windows GUI、真实高对比模式、屏幕阅读器、DPI/多显示器、实际空闲 CPU 仍建议在 Windows 实机验收。

## 未做 / 边界

- 不做语音输入、跨平台、主题商店/支付/审核、对 Codex 的反向控制或输入注入。
- 仍不读取对话正文；会话态只读元数据。
- 皮肤包仅支持本地文件夹导入（不支持 ZIP/网络下载/自动更新），manifest 仅 v1；导入偏好不会重建缺失的图片皮肤。
- 未重做 #2/#3 动效；未 bump 发布版本、未打 tag、未 merge main。
