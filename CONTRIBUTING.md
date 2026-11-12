# 参与议事间 · Contributing

欢迎贡献代码、文档、可复现的 CLI 兼容性问题，以及真实使用中的反馈。问题和 Pull Request 可以使用中文或英语。[社区行为准则](CODE_OF_CONDUCT.md)

## 从哪里开始

复现错误时，请写明操作系统、Node.js 和对应 CLI 版本、所选讨论模式、复现步骤、预期结果与实际结果。一句虚构的问题通常就足够复现。用 `node server.mjs --debug` 启动可以看到每次 CLI 调用的参数、退出码和错误输出；附上之前请先检查，移除本机路径、用户名和账号信息。截图和日志里也请移除私人对话和启动地址中的访问凭证。[Issues](https://github.com/juny1zhang/decision-room/issues)

想交流一种讨论流程或提出范围较大的想法，可以先介绍使用场景。小规模修复和文档改进可以直接提交 Pull Request。[Discussions](https://github.com/juny1zhang/decision-room/discussions)

涉及凭证、讨论数据泄露或本机权限的问题，请使用项目的私下报告渠道。[安全报告](SECURITY.md)

## 本地开发

Fork 仓库并克隆自己的副本，在项目目录里运行以下命令。项目需要 Node.js 22 或更高版本。

```sh
node --version                     # 22 或更新
npm test                           # 单元测试和集成测试，使用模拟 CLI，不需要 npm install
npm ci                             # 安装开发工具：ESLint、Prettier 和 Playwright
npm run lint                       # ESLint
npm run format                     # 用 Prettier 格式化（Markdown 由人工维护，不自动格式化）
npm run test:ui                    # 用 Playwright 在 Chromium 中运行浏览器测试
node scripts/check-cli-contract.mjs  # 对照本机安装的 CLI 检查适配器的参数
```

`npm test` 使用 Node.js 内置的测试工具。集成测试在临时目录启动服务，用三个模拟 CLI 检查完整流程，开发者无需登录模型账号即可复现。浏览器测试同样使用模拟 CLI，需要 Playwright 的 Chromium：第一次运行前执行 `npx playwright install chromium`（Linux 缺少系统库时加 `--with-deps`），或用 `DECISION_ROOM_CHROMIUM` 指定一个 Chromium 可执行文件。持续集成在 Ubuntu（Node.js 22 和 24）和 macOS（Node.js 26）上运行 `npm test`，在 Ubuntu 上用 Chromium 运行 `npm run test:ui`，并检查 lint 和格式。

用 `npm start` 打开应用，或用 `node server.mjs --no-open` 只打印访问地址。开发时可以用 `DECISION_ROOM_DATA_DIR` 指定一个临时目录，避免改动自己的讨论记录。要检查真实模型响应，请在本机登录相应的 CLI，用 `npm run check` 核对连接，再发送一句简短问题。真实请求会使用对应账号的额度。

## 代码结构

`server.mjs` 只是入口，服务端代码在 `src/`，页面在 `public/`。

| 如果你要修改… | 从这里开始 |
| --- | --- |
| 启动参数、端口、数据目录和关闭流程 | [src/main.mjs](src/main.mjs) · [src/data-dir.mjs](src/data-dir.mjs) · [src/config.mjs](src/config.mjs) |
| HTTP 接口、访问凭证、Host/Origin 检查和静态文件 | [src/http.mjs](src/http.mjs) |
| 一轮讨论的阶段、实时预览事件和单次调用的检查 | [src/discussion.mjs](src/discussion.mjs) · [src/invoke.mjs](src/invoke.mjs) |
| 提示词、历史发言的选取和分析能力 | [src/prompts.mjs](src/prompts.mjs) · [src/capabilities.mjs](src/capabilities.mjs) |
| 连接检查和结果缓存 | [src/health.mjs](src/health.mjs) |
| 启动 CLI、清理环境变量、隐藏凭证 | [src/process.mjs](src/process.mjs) · [src/redact.mjs](src/redact.mjs) |
| CLI 失败的原因分类 | [src/diagnostics.mjs](src/diagnostics.mjs) |
| 讨论记录、偏好设置和标题 | [src/storage.mjs](src/storage.mjs) · [src/preferences.mjs](src/preferences.mjs) · [src/titles.mjs](src/titles.mjs) |
| Markdown 导出、发言和阶段的名称 | [src/export.mjs](src/export.mjs) · [src/messages.mjs](src/messages.mjs) |
| 校验浏览器提交的设置 | [src/validation.mjs](src/validation.mjs) |
| 某个 CLI 的登录检查、模型列表、调用参数和输出解析 | [src/providers/](src/providers/)：每个 CLI 一个模块，[index.mjs](src/providers/index.mjs) 是注册表 |
| 页面结构和样式 | [public/index.html](public/index.html) · [public/app.css](public/app.css) |
| 页面逻辑 | [public/app.js](public/app.js) 是入口，各模块在 [public/js/](public/js/)，模块说明见 app.js 开头 |
| 回答的 Markdown 显示 | [public/js/markdown-parse.js](public/js/markdown-parse.js)（不依赖 DOM）· [public/js/markdown.js](public/js/markdown.js) |
| 单元测试 | [tests/unit/](tests/unit/) |
| 集成测试、测试服务和模拟 CLI | [tests/integration/](tests/integration/) · [tests/support/harness.mjs](tests/support/harness.mjs) · [tests/support/mock-cli.mjs](tests/support/mock-cli.mjs) |
| 浏览器测试（Playwright） | [tests/ui/](tests/ui/) · [tests/ui/support/browser.mjs](tests/ui/support/browser.mjs) |
| 真实 CLI 的输出样本 | [tests/fixtures/cli/](tests/fixtures/cli/) |
| 对照已安装的 CLI 检查参数 | [scripts/check-cli-contract.mjs](scripts/check-cli-contract.mjs) |

几条约定：

- 运行时只用 Node.js 内置模块，不增加运行时依赖。开发工具放在 `devDependencies`。
- CLI 一律不经过 shell 启动，问题和背景通过标准输入传给 CLI。
- `src/` 中的通用模块不写针对某个 CLI 的分支，差异放在 `src/providers/` 各自的模块里。
- 页面遵守严格的内容安全策略：没有内联脚本、样式或事件属性，用 `createElement` 和 `textContent` 构建 DOM，不用 `innerHTML`。
- 界面文字使用中文。文字不小于 11px，颜色对比度达到 4.5:1（图形标记 3:1），`tests/unit/ui-style.test.mjs` 会检查字号。
- 新的集成测试放在新的测试文件里，通过 `harness(t, control, { env, args })` 启动服务；`control` 决定模拟 CLI 的回答、失败和延迟。

## 添加一位参与者

1. 在 `src/providers/` 新建一个模块，默认导出 `{ id, label, binaries, missingHint, envDenylist, apiKeyEnv, supportsWeb, inspect, invoke, contract }`。各字段的含义写在 [src/providers/index.mjs](src/providers/index.mjs) 开头，可复用的辅助函数在 `common.mjs` 和 `stream.mjs`。`envDenylist` 要列出会让 CLI 改用 API 计费的变量。
2. 在 `index.mjs` 的 `PROVIDERS` 中注册。顺序就是页面上的显示顺序，前两位组成默认讨论。页面从 `/api/health` 读取参与者列表；`public/js/providers.js` 的 `DEFAULT_PROVIDERS` 只在第一次连接检查返回前使用，但要和注册表一致（`tests/unit/ui-providers.test.mjs` 会检查），所以也要在其中加入新参与者的 `id` 和 `label`。页面的其他代码不需要改。
3. 在 `tests/support/mock-cli.mjs` 中按这个 CLI 自己的输出格式模拟版本、帮助、登录状态、模型列表和回答，在 `tests/support/harness.mjs` 中加入它的模拟程序。再更新写明参与者的测试：`tests/unit/registry.test.mjs` 中的列表、`tests/integration/runtime.test.mjs` 中连接检查返回的 `providers`，以及 `tests/unit/validation.test.mjs` 中列出参与者名称的错误提示。
4. 在 `tests/unit/contract.test.mjs` 的 `ANSWERS` 中为它加入回答，让契约测试走完登录检查、模型列表和一次回答；这项测试对每位参与者都会运行。可选：把真实 CLI 的输出样本放进 `tests/fixtures/cli/`，在同一文件的 `CAPTURED` 中登记，在测试「the check before a CLI is first used…」的 `expected` 中列出它运行的命令，并在 `.github/workflows/cli-canary.yml` 中安装它。
5. 可选：在 `public/app.css` 中添加 `[data-provider='<id>']` 规则，设置 `--provider-ink`、`--provider-soft` 和头像字符 `--avatar`。没有规则时，页面使用中性颜色和名称的第一个字。

## CLI 输出样本和每周检查

模拟 CLI 体现的是维护者对真实 CLI 的理解，官方 CLI 改了参数时它们仍会通过。为此，每个适配器都导出 `contract`：版本命令、帮助命令，以及它传给每个命令的全部参数。`tests/unit/contract.test.mjs` 记录适配器实际传出的参数并与 `contract` 比对，再用 `tests/fixtures/cli/` 中逐字保存的真实帮助输出确认这些参数仍然存在。新增或删除参数时，要同时更新适配器的 `contract`，对 Codex 和 Claude 还要把该参数的帮助段落放进样本，否则测试会失败。

[CLI canary](.github/workflows/cli-canary.yml) 工作流每周一安装最新版的 Codex、Claude Code 和 Cursor Agent，运行 `node scripts/check-cli-contract.mjs`。它只执行版本和帮助命令以及 `codex debug models`，不需要登录，也不发送问题。检查失败时，安装新版本，按 [tests/fixtures/cli/README.md](tests/fixtures/cli/README.md) 重新采集样本并更新 `CAPTURED`；如果新版本不再列出某个参数，先修改适配器和它的 `contract`。Cursor 的样本还没有采集，它的检查暂时不会让工作流失败。

## 提交改动

在自己的分支上完成改动，运行 `npm test`、`npm run lint` 和 `npm run format`，然后向 `main` 提交 Pull Request。说明用户能观察到的变化，以及你验证了哪些场景。用户能注意到的变化请写进 [CHANGELOG.md](CHANGELOG.md) 的「未发布」部分。如果修复涉及特定的 CLI 输出或版本，请尽量用模拟 CLI 复现，方便其他贡献者在自己的机器上验证。

## Contributing in English

Bug reports, ideas, docs and code are welcome in English and Chinese. For a bug, share your OS, the CLI and Node.js versions, a short reproduction with a made-up prompt, and the expected and actual results. Output from `node server.mjs --debug` helps; review it first and remove local paths, your user name and account details. [English quickstart](README.en.md) · [Security reports](SECURITY.md)

**Develop.** Use Node.js 22 or newer. `npm test` runs the unit and integration tests against local mock CLIs and needs no `npm install`. `npm ci` installs the development tools for `npm run lint` (ESLint), `npm run format` (Prettier; Markdown is formatted by hand) and `npm run test:ui` (browser tests with Playwright and the mock CLIs; run `npx playwright install chromium` once first, or set `DECISION_ROOM_CHROMIUM` to a Chromium executable). `node scripts/check-cli-contract.mjs [codex] [claude] [cursor]` checks the CLIs installed on your machine against the adapters. Set `DECISION_ROOM_DATA_DIR` to a scratch folder to keep your own discussions out of manual tests; real model calls use your own signed-in CLI and its quota.

**Layout.** `server.mjs` is a thin entry point. The server lives in `src/`: `main.mjs` (startup), `http.mjs` (routes, token, static files), `discussion.mjs` and `invoke.mjs` (a round and each call), `prompts.mjs`, `health.mjs`, `process.mjs` (spawning CLIs without a shell, environment scrubbing), `diagnostics.mjs`, `storage.mjs`, `preferences.mjs`, `export.mjs` and the provider registry in `src/providers/`, one module per CLI. The page is `public/index.html`, `public/app.css`, `public/app.js` and browser modules in `public/js/`, under a strict CSP: no inline scripts, styles or handlers, and no `innerHTML`. Tests are in `tests/unit/`, `tests/integration/` and `tests/ui/` (browser tests); `tests/support/` holds the server harness and the mock CLIs, and `tests/fixtures/cli/` holds verbatim output of real CLIs. Keep the runtime free of dependencies, keep provider-specific code in its provider module, and write user-facing text in Chinese.

**Add a provider.** Write a module in `src/providers/` that default-exports `{ id, label, binaries, missingHint, envDenylist, apiKeyEnv, supportsWeb, inspect, invoke, contract }` (documented at the top of `src/providers/index.mjs`) and register it in `PROVIDERS` in `index.mjs`. The page reads the list from `/api/health`, but also add its id and label to `DEFAULT_PROVIDERS` in `public/js/providers.js`, which `tests/unit/ui-providers.test.mjs` keeps equal to the registry. Teach `tests/support/mock-cli.mjs` the CLI's output format, add it to `tests/support/harness.mjs`, give it an entry in `ANSWERS` in `tests/unit/contract.test.mjs` (the contract test runs for every provider), and update the provider lists in `tests/unit/registry.test.mjs` and `tests/integration/runtime.test.mjs` and the participant message in `tests/unit/validation.test.mjs`. Optionally add captured output to `tests/fixtures/cli/`, to `CAPTURED` and to the `expected` commands of the first-use check test in the contract test, install it in the canary workflow, and give it colours with a `[data-provider='<id>']` rule in `public/app.css` (`--provider-ink`, `--provider-soft`, `--avatar`; contrast of at least 4.5:1).

**Fixtures and the weekly canary.** Each adapter exports a `contract` listing every flag it passes. `tests/unit/contract.test.mjs` checks the flags the adapters actually pass against it, and the contract against verbatim help output in `tests/fixtures/cli/`, so a flag added or removed in an adapter must also change its `contract` (and, for Codex and Claude, the help fixture). Every Monday the [CLI canary](.github/workflows/cli-canary.yml) installs the latest Codex, Claude Code and Cursor Agent and runs `scripts/check-cli-contract.mjs`, which runs only version and help commands and `codex debug models`: no login, no prompt. When it fails, recapture the fixtures as described in [tests/fixtures/cli/README.md](tests/fixtures/cli/README.md). The Cursor check is not verified yet and does not fail the workflow.

**Send a change.** Fork the repository, run `npm test`, `npm run lint` and `npm run format`, then open a pull request against `main` describing what changed and how you tested it. Add user-visible changes to the Unreleased section of [CHANGELOG.md](CHANGELOG.md).
