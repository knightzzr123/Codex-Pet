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
