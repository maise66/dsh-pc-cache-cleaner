# dsh-pc-cache-cleaner · 缓存清理

给 DeepSeek Harness 做的一键缓存清理插件：侧栏底部一个 **「清理缓存」** 按钮，点一下就把电脑上该清的缓存清掉，并在按钮上方弹出结果卡片（释放了多少、删了多少项、跳过多少项、扫了哪些盘符）。

同一个清理核心还暴露了三个入口，逻辑完全一致：

| 入口 | 谁用 | 形式 |
|---|---|---|
| 侧栏按钮 | 你 | `POST /cache-clean/run`（同源、带登录态） |
| `/cache-clean` 斜杠命令 | 你在会话里 | `dsh-commands` 注册的命令 |
| `cache_clean` 工具 | Agent | `dsh-tools` 注册的工具，返回结构化结果 |

---

## 安装

在 Harness 里让插件管理器安装本目录即可（本目录就是包根，`package.json` 里 `dsh.bundle.patch` 指向补丁文件）：

```text
plugin_manager  →  install_bundle  →  C:\Users\Administrator\Desktop\Ai_project\plugins\dsh-cache-cleaner
```

装完后：

- bundle 名：`dsh-pc-cache-cleaner`（`package.json` 的 `name`）
- profile 行 id：`pc-cache-cleaner`
- 侧栏底部立刻出现「清理缓存」按钮，无需重启

卸载：`plugin_manager` → `remove_bundle` → `dsh-pc-cache-cleaner`。

> 目录名是 `dsh-cache-cleaner`，包名是 `dsh-pc-cache-cleaner`：包名是 Host 加载模块用的说明符，改包名会产生新的模块代次，这在“改了 Host 代码想立即生效”时会用到（见下方「改动如何生效」）。

---

## 清理范围

默认目标来自 `lib/cleaner.js` 的 `DEFAULT_TARGETS`，**覆盖所有已挂载的盘符**（启动时枚举 A:–Z:，系统盘优先）：

| id | 显示名 | 实际位置 |
|---|---|---|
| `temp` | 系统临时文件（全盘） | `%TEMP%`、`%SystemRoot%\Temp`，以及**每个盘符**的 `X:\Temp`、`X:\Windows\Temp` |
| `windows-update` | Windows 更新缓存（全盘） | **每个盘符**的 `X:\Windows\SoftwareDistribution\Download` |
| `thumbnails` | 缩略图缓存 | `%LocalAppData%\Microsoft\Windows\Explorer\thumbcache_*.db`、`iconcache_*.db` |
| `browser-cache` | 浏览器缓存 | Chrome / Edge / Brave / Chromium / Opera / Opera GX / Firefox 的 Cache、Code Cache、GPUCache、cache2 |
| `dns` | DNS 解析缓存 | `ipconfig /flushdns` |
| `npm-cache` | npm 下载缓存 | `npm_config_cache` 或 `%LocalAppData%\npm-cache`（**默认不勾**，删了要重新下载） |
| `dsh-archived-shots` | DSH 已归档会话截图 | `$DSH_HOME/data/computer-use/shots` 下**经三重约束**的截图（见下节，**不在默认目标里**） |

只清理“存在的根目录”，不存在的候选路径不会被计成失败；正在使用的文件（浏览器开着、缩略图被资源管理器占用）会计入“跳过”而不是报错。

---

## `dsh-archived-shots`：DSH 已归档会话截图

这个目标和其它目标不是一类东西：**它删的不是缓存，而是能证明属于已归档会话的截图**。所以它**故意不在 `DEFAULT_TARGETS` 里**——不能因为点了一下按钮就顺手把会话证据删掉，必须由人显式点名。

### 删什么

`$DSH_HOME/data/computer-use/shots` 下**同时**满足三条的截图文件：

1. **台账有记录**：文件名出现在 `$DSH_HOME/data/computer-use/owned-shots.jsonl` 里；
2. **内容与记录一致**：磁盘上的字节数等于记录的 `size`，且 sha256 等于记录的 `sha256`；
3. **没有任何活跃会话产出或读过它**：所有产出方都在 `$DSH_HOME/storages/workspace.json` 的 `global.archivedSessionIds` 里（子会话随其父会话判定），且没有活跃会话 `read_image` 过它；同时至少要有一个产出方。

「产出」只认 `computer_shot` / `computer_marks` / `computer_batch`；「读过」只认 `read_image` / `computer_uia` / `computer_state`。**列目录时印出文件名不算**（`pwsh`、`grep` 之类）——那种引用不建立对文件的依赖，不阻止删除，但会在报告里如实计数。

### 怎么用

```text
# 只测量：报出候选清单，一个都不删（默认就是这个）
cache_clean { targets: ["dsh-archived-shots"] }

# 真的删：必须显式 dryRun: false
cache_clean { targets: ["dsh-archived-shots"], dryRun: false }

# 斜杠命令同理
/cache-clean dsh-archived-shots
```

- **默认 dry-run**：不传 `dryRun` 就是试运行，`bytes` 读作「**预计**释放」而不是「已释放」，汇总行也会写「试运行…（未删除）」。真实删除必须传 `dryRun: false`；
- 报告里 `targets[].skippedFiles` 列出**每个被挡下的文件与理由**（`no-manifest-record`、`size-mismatch`、`sha256-mismatch`、`no-producer`、`live-producer:<会话>`、`live-consumer:<会话>`），候选数才有意义；
- 删除前会再核对一次字节数，缩小「判定」与「动手」之间的窗口。

### 边界

- **活跃会话产出或读过的截图永不删**，哪怕它更旧、更大；
- 只删 `shots/` 里的**文件**，目录本身永不删除；只处理 `shot-*.jpg|png` 命名的文件，别的图片（人放进去的）一律不碰；
- **附件存储不在本目标范围内**：转录里渲染的图片按 sha256 存放在 `$DSH_HOME/attachments/v1/objects` 与 `$DSH_HOME/cache/attachments/request-images`，删掉 `shots/` 副本**不会**让历史对话里已渲染的图片消失。实测（口径写清：**出现次数**与**不同名字数**是两个量）：转录里 image 部件出现 **211 次**、涉及 **201 个不同图片名**，其中字节 211/211 都能在附件存储里按摘要找到；而这 201 个名字里只有 **41 个**的文件曾经在 `shots/` 内；
- **只读两个台账，从不写它们**。删掉文件后 `owned-shots.jsonl` 会留下指向不存在文件的记录，这是无害的：读取方对缺失文件是 `try/catch` 跳过。若哪天想彻底清账，由人手工处理——本插件不碰台账；
- 注册表或台账读不出来（JSON 坏了、文件不在）时**明确失败并一个都不删**。

### 恢复

被删的 `shots/` 副本**无法从本插件恢复**（没有回收站）。但：

1. 历史对话里已渲染的图片不受影响——它们读的是附件存储里的不可变副本；
2. 若做过迅雷网盘备份，可从那台机器的 `dsh-backup-*.zip` 里取回 `plugins/` 与 `skills/`；注意**备份包不含 `shots/` 目录**，截图本身不在备份范围内。

因此第一次用建议先跑默认的 dry-run，看清候选清单再决定。

---

## 配置

补丁文件 `cordis.patch.yml` 里按行 id 覆盖 `config`（**整体替换，需要写全**）：

```yaml
- insert:
    - id: pc-cache-cleaner
      name: 'dsh-pc-cache-cleaner'
      config:
        enabled: true            # false = 关掉整个插件
        targets:                 # 点按钮时清理哪些目标
          - temp
          - windows-update
          - thumbnails
          - browser-cache
          - dns
          # - npm-cache          # 需要时再打开
          # - dsh-archived-shots # 截图：建议先 dry-run 看清候选再决定是否放进这里
```

改完配置后重新安装本 bundle（`install_bundle`）即可热生效。

> 把 `dsh-archived-shots` 写进 `targets` 等于让侧栏按钮和 `/cache-clean`（不带参数时）**默认试运行**它——仍然不会真删，因为该目标的 dry-run 默认开着。真要删只能走 `cache_clean { dryRun: false }`。

---

## HTTP 接口（都要求已登录的同源请求）

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/cache-clean/run` | 执行一次清理，返回完整报告 JSON（`freedBytes`、`filesDeleted`、`drives`、逐项明细） |
| `GET` | `/cache-clean/ping` | 健康探针：`{ ok, version, drives, targets }`，未登录返回 401 |

鉴权用宿主的 `connection.requestRejection(req)`：没登录是 401，跨站/非回环请求是 403。不要给这两个接口加 `credentials: 'omit'`，否则一定 401。

`/cache-clean/run` 清的是**配置里的 `targets`**。所有入口都**不传 `dryRun`**，因此 `dsh-archived-shots` 在这里同样是**试运行**（`options.dryRun !== false` ⇒ `undefined !== false` ⇒ true），只报「预计释放」，一个文件都不删。实测：

```text
targets-only call: dryRun=true deleted=0 candidates=55 bytes=5527770
summary: 预计释放 5.3 MB（删除 0 项，跳过 0 项，耗时 4.1 秒）。DSH 已归档会话截图：试运行，可清 5.3 MB（未删除）。
```

也就是说，**只有 `cache_clean { dryRun: false }` 这一条路会真删**。侧栏按钮与斜杠命令即便把该目标写进 `targets`，也只会给出预览。

---

## 安全边界

- 只打开白名单里的根目录，且**只删根目录的“内容”**，根目录本身永不删除；
- 符号链接/联接只跳过、绝不跟随；
- 只有空目录才会 `rmdir`；
- 单个文件删除失败（占用、无权限）计为“跳过”，不会中断整次清理；
- 并发上限 8，取消信号会中止当前这轮；
- 同一时刻只允许一次清理在跑，重复点击会复用同一次运行；
- **`dsh-archived-shots` 额外**：默认试运行、逐文件核对台账与 sha256、活跃会话碰过的一律不删、注册表/台账读不出来就明确失败且一个都不删。

---

## 目录结构

```text
plugins/dsh-cache-cleaner/
├─ package.json            # 包名、dsh.bundle.patch、dsh.client 声明
├─ cordis.patch.yml        # 把插件插入 profile 的 Loader 树
├─ host.js                 # Host 半身：HTTP 路由 + 斜杠命令 + Agent 工具
├─ client.js               # 浏览器半身：侧栏按钮与结果卡片
├─ lib/cleaner.js          # 清理核心：目标表、根目录解析、缓存树删除
├─ lib/archived-shots.js   # 已归档会话截图：判定规则与删除（纯 Node）
├─ locale/zh.json          # 插件页标题/描述（中文）
├─ locale/en.json          # 插件页标题/描述（英文）
└─ icon.svg                # 插件图标
```

自测（只测量、不删除）：

```powershell
$env:ELECTRON_RUN_AS_NODE=1; $env:ELECTRON_NO_ASAR=1
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe" plugins\tools\test-cleaner.mjs
```

`dsh-archived-shots` 的判定规则自测（在临时目录里造假 DSH_HOME，含反向用例；不碰真实截图）：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node notes\dsh-archive-shots\self-test.mjs notes\dsh-archive-shots\self-test-report.json
```

口径与判定规则的完整说明（含为什么不能只看文件名、为什么必须逐帧解 zstd）见 `notes/dsh-archive-shots/spec.md`。

---

## 改动如何生效

- **`client.js`（按钮、文案、样式）**：客户端 HMR，保存后刷新插件即可，不用重启。
- **`host.js` / `lib/cleaner.js`（清理逻辑、路由、命令、工具）**：Host 是常驻 Node 进程，按说明符缓存 ESM 模块，改文件**不会**重新加载（官方文档：替换已安装包需要重启）。两种做法：
  1. 重启 Harness（推荐，改动随下次启动生效）；
  2. 想立即生效就换一个新的包名/行 id，让 Host 以从未导入过的新说明符加载（本插件从 `dsh-cache-cleaner` 改成 `dsh-pc-cache-cleaner` 就是这个原因）。

  `host.js` 里对核心的导入写成 `./lib/cleaner.js?gen=3`，也是同一原理：带查询参数的说明符是另一个模块，可绕开 ESM 缓存。改核心代码后把 `gen` 加一即可（`lib/archived-shots.js` 由 `cleaner.js` 静态导入，跟着 `cleaner.js` 的代次一起换）。

> **不要用 PowerShell 的 `Get-Content -Raw` + `Set-Content` 改这些文件**：Windows PowerShell 会按 ANSI（本机 GBK）读 UTF-8 源文件，中文全变乱码、正则也会崩。用编辑工具改，或显式指定 `-Encoding UTF8` 并确认读进来时也是 UTF-8。
