# 更新记录 · Changelog

这里记录用户能注意到的变化，最新的版本在最上面。English summaries follow the Chinese notes of each version.

## 未发布 · Unreleased

### 新功能

- **目标模式。** 参与者先各自提出方案，主持人合并成方案 v1，其他参与者评审并在最后一行写「结论：认可」或「结论：需修改」，主持人据此修改，直到全员认可同一版，这一版标为「最终方案」。「最多几版」（1 到 6，默认 3）限制版本数；到了上限仍未全员认可时，讨论暂停并说明谁还不认可，可以点「继续磨合」再修改同样多的版数。缺少任何一份评审都不算认可，讨论会暂停，可以重试未完成的部分。导出注明每一版、每份评审的结论和最终方案。
- **实时预览。** 回答生成时，页面显示标着「生成中…」的预览卡片，并提示参与者正在思考或检索网页，完整回答到达后替换预览。Claude Code 和 Cursor Agent 只在帮助信息列出所需参数时才使用流式输出，旧版本 CLI 继续一次性输出。
- **用时和用量。** 每条回答注明用时，以及 CLI 报告的输入、缓存和输出 token 数；导出的 Markdown 也包含这些信息。Cursor Agent 不报告用量。
- **自动重试。** 调用因连接中断失败时，自动重试一次。
- **部分参与者失败时继续讨论。** 联合讨论里只要至少两位参与者给出了独立意见，讨论就会继续，并说明谁没有参与。
- **「重试未完成的部分」。** 失败或被停止的一轮，可以只补上缺少的发言，已完成的内容保留。
- **整理讨论。** 侧栏可以按标题搜索讨论（不区分大小写和全角半角），也可以重命名和删除讨论。正在进行的讨论标为「进行中」，不能改名或删除，在另一个标签页启动的也一样。
- **按问题命名。** 新讨论以第一个问题的首行命名，最多 38 个字符；从页面示例开始的讨论以填写的内容命名，不再共用同一个标题。
- **更完整的 Markdown。** 支持裸网址、带括号的链接、斜体、删除线、按缩进嵌套的列表、列表里的代码块、代码块的语言标注和表格的列对齐。
- **设置跟着数据目录走。** 讨论设置和打开的讨论保存在数据目录的 `preferences.json`，重启、换端口或换浏览器后都能恢复。未发送的草稿仍保存在浏览器里。
- **固定端口。** 访问地址默认使用端口 41710，每次启动都一样；端口被占用时改用随机端口并在终端说明。`DECISION_ROOM_PORT` 可以指定端口，`0` 表示随机端口。
- **调试模式。** `--debug` 或 `DECISION_ROOM_DEBUG=1` 在终端输出 CLI 调用、连接检查和请求的诊断信息。输出不含问题和回答，凭证会被隐藏，但可能包含本机路径和 CLI 错误信息的片段，分享前请检查。
- **Linux。** 启动后用 `xdg-open` 打开浏览器。访问凭证经由只有当前用户能读取的本地文件交给浏览器，不会出现在其他用户也能看到的命令行里。
- 「工具连接」会提示被忽略的 API Key 环境变量。

### 改进

- 共同背景按问题记录：背景改变后，新背景随下一个问题保存，历史和导出都按每个问题当时的背景。导出在更新了背景的问题下注明「共享背景（本轮更新）」。
- 提示词把问题、共同背景、历史和其他参与者的意见放进带标签的分段，每个阶段都有长度预算。
- 导出使用中文阶段名，标题中的时间是本地时间并注明 UTC 偏移。
- 连接检查更快：版本和帮助检查按可执行文件复用，登录状态不变时模型目录复用 180 秒，各项检查并行运行，服务启动后在后台先检查一遍。已检查过的三方讨论开始前，检查进程从 10 个减到 3 个。
- 一轮结束后只刷新侧栏，不再三次读取讨论列表并重绘所有消息。
- 连接状态除了颜色还用形状区分；文字不小于 11px，颜色对比度达到 WCAG AA。
- Claude 每次回答最多可用 30 轮（原来是 8 轮）。开着联网、推理档位较高时，原来的上限常常不够，结果报「达到本轮工具调用上限」。
- 从 Claude Code 会话里启动议事间时，CLI 不再继承那个会话的变量，其中包括它的消息凭证。
- Cursor 与模型服务的数据流多次停滞（`Connection stalled`）时，页面说明原因并建议换模型，不再只显示退出码。
- 超时提示按实际的等待上限说明。
- 显示方式的变化：紧接在列表项下方的文字会并入该项，反斜杠转义生效，段落后紧跟的 `---`、`***` 或 `___` 显示为分隔线。

### 修复

- **重启后设置丢失。** 之前每次启动都使用随机端口，浏览器按地址保存的设置在下次启动时就找不到了。现在端口固定，设置也保存在服务端。
- **长回答后历史被丢弃。** 只要最近一条回答超过 48,000 字符的历史预算，服务端就完全不发送历史，提示词还声称「这是新讨论」。现在超过 12,000 字符的发言只保留开头和结尾，问题和主持人总结优先保留，省略的地方会注明。
- **错误原因判断有误。** 之前也从模型自己的回答里判断失败原因，所以回答中提到额度或登录的网络故障会被报成额度或登录问题，过期的证书也会被报成登录过期。现在只依据 CLI 的错误输出和它报告的结构化错误分类，更多连接失败会被识别为网络问题。
- 快速连续打开两场讨论时，显示的是后打开的那场。
- 窄屏上收起的侧栏不再获得焦点；打开时焦点移入，被侧栏遮住的页面不会获得焦点，在任何位置按 Escape 都能关闭。
- 连接检查失败后，「模型与能力」对话框不再出错，也不再清空已选的推理强度和分析能力。
- 重新打开页面或重启后，未发送的共同背景不再被讨论保存的背景覆盖，之后改过的设置也不再被这场讨论上一轮的设置覆盖。
- 打开讨论时，读屏软件不再朗读全部记录；「模型与能力」中的字段名称包含参与者名称；输入框获得焦点时有清晰的边框。
- 发送、停止或「重试未完成的部分」后，键盘焦点回到输入框；重命名后讨论被搜索隐藏时，焦点移到「新的讨论」。
- 宽屏侧栏不再多出一个「导出当前讨论」按钮；引用保留换行，引用中的列表不再挤成一行。
- Cursor 的登录、额度和模型错误不再被当作连接中断，因此不会被自动重试。
- 保存讨论失败时，仍在运行的调用随之停止，不会在讨论结束后再写回记录。
- 请求内容过大时，浏览器能收到完整的错误提示。
- 检查 CLI 参数时按完整的参数名匹配，`--mode` 不再因为帮助中有 `--model` 而被当作受支持。
- 损坏的讨论记录会给出明确提示；讨论列表跳过无法读取的文件，缺少更新时间的记录按创建时间或文件时间排序。

### 不兼容的变化

- 需要 Node.js 22 或更新版本。旧版本启动时会提示当前版本并退出。
- 数据目录默认改为系统的应用数据目录：macOS 为 `~/Library/Application Support/Decision Room/`，Linux 为 `$XDG_DATA_HOME/decision-room/`（默认 `~/.local/share/decision-room/`）。项目里的 `data/rooms/` 仍有讨论时继续使用 `data/`，终端会说明怎样迁移。`DECISION_ROOM_DATA_DIR` 的作用不变。
- `/api/` 下的请求缺少访问凭证或凭证错误时返回 401（之前是 403），其他未知路径返回 JSON 格式的 404。Host 或 Origin 不符仍返回 403。

### 开发

- 服务端拆分为 `src/` 下的模块，每个 CLI 在 `src/providers/` 中有自己的适配器；页面拆分为 `public/` 下的 ES 模块，并启用严格的内容安全策略。`ui.html`、`providers.mjs` 和 `cursor-provider.mjs` 已移除，`capabilities.mjs` 移到 `src/`。
- 测试分为单元测试和集成测试，共用一个测试服务；加入 ESLint、Prettier 和 Playwright 开发工具，运行时仍然没有依赖。
- 持续集成在 Ubuntu（Node.js 22、24）和 macOS（Node.js 26）上运行测试，并检查 lint 和格式。
- 适配器导出 `contract`，契约测试对照真实 CLI 的帮助输出检查参数；每周的 CLI canary 用最新版本运行 `scripts/check-cli-contract.mjs`。
- `package.json` 增加 `bin`（`decision-room`）和 `files`，`engines` 改为 `>=22`。

### English summary

- **New:** goal mode (目标模式): participants propose plans, the moderator merges them into one plan and revises it from the others’ reviews until all of them approve the same version, marked as the final plan; 最多几版 caps the versions (1 to 6, default 3), and 继续磨合 allows as many more after a turn stops at the cap without consensus; a missing review pauses the turn instead of counting as approval; live answer previews while a CLI writes, with thinking and web-search status; each answer's duration and token counts, also in the export; one automatic retry when a connection drops; a joint discussion continues when at least two participants answered, with a notice about who is missing; **重试未完成的部分** reruns only the missing parts of an incomplete round; search, rename and delete discussions in the sidebar; new discussions are named after their first question; richer Markdown (bare URLs, emphasis, strikethrough, nested lists, code captions, table alignment); settings and the open discussion saved in `preferences.json`; a fixed port, 41710, with `DECISION_ROOM_PORT` to override it; a debug mode (`--debug` or `DECISION_ROOM_DEBUG=1`); the browser opens on Linux with `xdg-open`.
- **Improved:** the shared context is recorded per question; prompts use tagged sections and per-stage size budgets; exports use Chinese stage names and local times with the UTC offset; connection checks are reused, run in parallel and warm up at startup; connection status no longer relies on colour alone, and the page meets WCAG AA contrast with no text below 11px; a Claude answer may take 30 turns instead of 8, so researched answers no longer hit the turn limit; CLIs no longer inherit the variables of a Claude Code session Decision Room was started from.
- **Fixed:** settings were lost on restart because every launch used a new random port; one long answer dropped the whole history and the prompt claimed a new discussion; failures were classified from the model's own answer, so a network error could be reported as a quota or login problem and an expired certificate as an expired login. Also: reopening the page no longer replaces an unsent shared context or newer settings with the open discussion's saved ones; Cursor login, quota and model errors are no longer retried as lost connections; a failed save stops the calls still running; on Linux the access token stays off command lines; and keyboard and screen-reader use is better (focus after a round, in the drawer and after a rename, field names, no re-reading of a whole discussion, a visible prompt focus).
- **Breaking:** Node.js 22 or newer is required; data now defaults to the operating system's application data folder (a legacy `data/` folder that holds discussions is still used, and `DECISION_ROOM_DATA_DIR` still overrides both); a missing or wrong access token on `/api/` now answers 401 instead of 403, and unknown paths outside it a JSON 404.
- **Development:** the code is split into `src/` and `public/` modules with a provider registry; ESLint, Prettier and Playwright are development tools; CI runs on Ubuntu and macOS with Node.js 22, 24 and 26; adapter contracts are checked against captured CLI help and, every week, against the latest CLI releases; `package.json` gains `bin` and `files`.

## 1.1.0 · 2026-11-12

以 MIT 许可证开放源代码，加入贡献指南、安全报告说明、问题模板和持续集成。

First open-source release under the MIT License, with a contributing guide, security reporting instructions, issue templates and CI.
