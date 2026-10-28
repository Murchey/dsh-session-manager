# DSH Session Manager（会话粉碎机）

基于 DeepSeek Harness 的会话管理插件：查看每个会话的磁盘占用，永久删除会话，并清理侧边栏中数据已不存在的失效条目。

> 仓库名：`dsh-session-manager`
> npm 包名：`dsh-session-storage`（仓库名与包名可以不同）

插件在侧边栏增加一个“会话存储”图标，打开一个专门页面，列出每个会话占用的空间，支持搜索、排序、单个或批量删除；同一个删除实现也注册为模型工具 `session_purge`。删除对象包括：

| 数据 | 位置（默认） | 处理 |
| --- | --- | --- |
| 会话日志（含所有历史格式代次） | `$DSH_HOME/sessions/<project>/<session-id>/` | 删除整个会话目录 |
| 投影缓存记录 | `$DSH_HOME/storages/session_projcache/sessions/<id>.json` | 删除 |
| 旧版整单元缓存种子里的记录（标题等） | `$DSH_HOME/storages/session_projcache.json` | 原子重写，移除该会话记录 |
| 仅被该会话引用的附件对象 | `$DSH_HOME/attachments/v1/objects/` | 全量引用扫描证明无人引用后删除 |
| 请求图片派生缓存 | `$DSH_HOME/cache/attachments/request-images/` | 删除附件后整体清空（可按需重新生成） |

DSH 的 `sessionPersistence` 接口明确没有删除 API（日志会一直累积到被外部清理），所以本插件直接做文件系统操作。为了保证“彻底”和“不误伤”，删除路径全部经过白名单根目录校验，并且附件只有在**完整扫描所有幸存会话**后才能删除。

## 安装

从 npm 安装（发布后）：

```bash
dsh plugin --profile <profile> add dsh-session-storage
```

本地开发安装：

```bash
dsh plugin --profile <profile> add link:<此目录绝对路径>
```

或让 DSH 内置的 Plugin Manager 安装本目录。安装后侧边栏会出现“会话存储”图标，同时 `session_purge` 工具可用。

本地目录安装是链接方式：profile 里记录的是此目录的绝对路径，移动或删除该目录会让插件失效。

## 页面

点击侧边栏的“会话存储”图标进入主面板：

- 顶部显示总会话数与磁盘占用；
- 每个会话显示标题、ID、项目目录、创建日期、占用空间和比例条；
- 运行中的会话标记为 `运行中`，不能选择（先结束会话再删除）；
- 支持按标题 / ID / 项目目录搜索，按大小或时间排序；
- 行尾“删除”按钮删除单个会话，“删除所选”批量删除；
- 删除前弹出确认对话框，明确显示数量、总字节数和“不可撤销”警告，并默认勾选“同时删除不再被其他会话引用的附件”；
- 删除成功后主动刷新 Client 会话目录，左侧会话列表同步移除条目；
- 顶部“清理失效栏目”按钮用于历史遗留：先向 Host 重新拉取权威会话目录，再把侧边栏中数据已不存在的条目从本地目录移除（不会删除任何仍然存在的会话）；删除成功后也会顺带执行同样的清理。

页面通过 Connection 的已认证 `/api/session-shredder/*` 路由读写；UI 的确认对话框就是人工闸门，Host 路由仍要求 `confirm:true` 并只接受 owner 浏览器会话。

## 工具

对模型说“永久删除会话 xxx”，模型会先 `list` / `plan`，展示精确的磁盘占用，然后再 `purge`：

```jsonc
// 1. 发现
{ "action": "list" }

// 2. 预览（只读）
{ "action": "plan", "sessionIds": ["session-..."] }

// 3. 真正删除；confirm 必须为 true
{ "action": "purge", "sessionIds": ["session-..."], "confirm": true }
```

`purge` 默认会请求 **approval 确认**，显示会话数量、总字节数与标题；拒绝、取消或没有可用确认渠道时一律不删除（fail closed）。如果用户把当前会话的 approval 策略切换为 `never`，插件会尊重这一显式选择、不再弹窗（仍要求 `confirm:true` 与顶层会话身份）。

## 安全规则

- 插件在 Host 进程内运行，**不受**会话 workspace 文件沙箱限制；它只按配置的数据根删除，并校验每个目标确实位于根内。
- 当前会话、本进程内仍存活的会话（含子代理）**拒绝删除**。
- 会话 id 只接受安全字符（顶层会话 `session-<token>`、子代理裸 UUID）；路径编码与 DSH 的 JSONL 后端完全一致，避免路径穿越。
- 只删除 `sessionsRoot` / `projectionCacheRoot` / `attachmentsRoot` 内部的真实目录，不跟随符号链接。
- 子代理会话不能调用该工具，只有顶层会话可以。
- 一次最多删除 `maxTargets`（默认 50）个会话。
- 附件删除前的引用扫描只要有一个幸存会话读不完整，就**整体放弃**附件删除，避免误删其他会话仍在使用的图片/文件。
- 附件对象只有在目标会话的日志与缓存**全部删除成功**后才会被清理；不会出现“日志还在但附件没了”。
- 请求图片缓存以变换哈希为键、无法按附件归属，因此只在确实删除了附件对象后整体清空；它能按需重建，不影响任何会话内容。
- 最近 10 分钟内写入的附件对象会被跳过，保护正在上传中的内容。
- 删除后逐个校验路径确实不存在；任何残留都会让结果 `verified: false`，不会假装成功。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖 `session-shredder` 行即可：

```yaml
- id: session-shredder
  name: dsh-session-storage
  config:
    requireApproval: true       # 默认 true；无人值守环境才建议关闭
    secureOverwrite: false      # true = 先用 0 覆盖文件内容再 unlink
    purgeAttachments: true      # 是否处理无引用附件
    clearRequestImageCache: true # 删除附件后清空请求图片派生缓存
    attachmentMinAgeMs: 600000  # 保护最近 10 分钟内写入的附件
    listLimit: 50
    maxTargets: 50
    # dataDir: 'D:\path\to\dsh-home'   # 默认取 $DSH_HOME，再退回 ~/.dsh
    # sessionsRoot: ...
    # storagesRoot: ...
    # projectionCacheRoot: ...
    # attachmentsRoot: ...
    # requestImageCacheRoot: ...
```

`secureOverwrite` 只是“覆盖后删除”的尽力而为：SSD 磨损均衡、写时复制文件系统与 NTFS 日志都可能保留旧数据，**不能**当作物理销毁保证。

## 不会处理的内容

- `workspace.json` 里的会话排序 / 归档 id：只是元数据，DSH 在下次 workspace 变更时会自动剪除；它们不包含会话内容。
- 会话搜索索引（若启用 SQLite 后端）：DSH 启动时会按持久化列表对账删除，重启后消失。
- `llm-deepseek/files-v3.json` 中的远端 `fileId` 映射：只有引用，不含内容，且远端文件会过期。
- 系统临时目录中由子进程产生的日志/溢出文件，以及 Web 端浏览器缓存。

## 验证

- `lib/core.js` 的删除逻辑可脱离 DSH 运行（见 `test/core.test.mjs`）。
- `test/client.test.mjs` 校验浏览器模块的注册、初始渲染、主题 token 使用和失效条目清理；`test/host.test.mjs` 校验两个 `/api` 路由的注册与错误分支。
- 安装后可从侧边栏打开页面，用 `list` / `plan` 对真实存储做只读核对。
- 页面删除与“清理失效栏目”已在真实 DSH Web UI 中验证：删除后侧边栏条目同步移除，历史残留可由按钮清理。
- UI 的确认对话框（以及工具路径的 approval 卡片）是人工闸门；测试真实删除时请只使用一次性会话。

## 发布到 npm

包已移除 `private`，`files` 只包含运行所需文件，GPL-3.0-only 随包附带 `LICENSE`。发布前先确认包名可用：

```bash
npm view dsh-session-storage version
```

`dsh-session-storage` 当前在 npm 上未被占用；`dsh-session-manager` 已被其他包使用，**不要**直接把包名改成仓库名。若之后需要改名，以下三处必须保持一致：

1. `package.json` 的 `name`；
2. `client.js` 里 `window.__ModuleLoader__.load({ id: ... })` 的 id；
3. `cordis.patch.yml` 中插件行的 `name`。

发布流程：

```bash
npm login
npm pack --dry-run        # 检查会打进 tarball 的文件
npm publish --access public
```

发布 scoped 包时使用 `@你的scope/dsh-session-storage`，并把上面三处同步改成该 scoped 名称；`npm publish --access public` 让公开 scoped 包可被安装。

版本升级：

```bash
npm version patch         # 或 minor / major
git add package.json
git commit -m "chore: release v$(node -p "require('./package.json').version")"
npm publish
```

用户安装发布后的插件：

```bash
dsh plugin --profile <profile> add dsh-session-storage
```

## License

GPL-3.0-only，见 [LICENSE](LICENSE)。