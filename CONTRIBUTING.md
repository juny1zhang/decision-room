# 参与议事间 · Contributing

欢迎贡献代码、文档、可复现的 CLI 兼容性问题，以及真实使用中的反馈。问题和 Pull Request 可以使用中文或英语。[社区行为准则](CODE_OF_CONDUCT.md)

## 从哪里开始

复现错误时，请写明操作系统、Node.js 和对应 CLI 版本、所选讨论模式、复现步骤、预期结果与实际结果。一句虚构的问题通常就足够复现。请从截图和日志中移除私人对话、账号信息和启动地址中的访问凭证。[Issues](https://github.com/juny1zhang/decision-room/issues)

想交流一种讨论流程或提出范围较大的想法，可以先介绍使用场景。小规模修复和文档改进可以直接提交 Pull Request。[Discussions](https://github.com/juny1zhang/decision-room/discussions)

涉及凭证、讨论数据泄露或本机权限的问题，请使用项目的私下报告渠道。[安全报告](SECURITY.md)

## 本地开发

Fork 仓库并克隆自己的副本，在项目目录里运行以下命令。

```sh
node --version
npm test
```

项目使用 Node.js 18 或更高版本和内置的测试工具。测试会在临时目录启动服务，用三个模拟 CLI 检查完整流程。开发者无需登录模型账号即可复现这些测试。

用 `npm start` 打开应用，或用 `node server.mjs --no-open` 只打印访问地址。要检查真实模型响应，请在本机登录相应的 CLI，用 `npm run check` 核对连接，再发送一句简短问题。真实请求会使用对应账号的额度。

| 如果你要修改… | 从这里开始 |
| --- | --- |
| 布局、选择模型和能力、显示实时回答 | [ui.html](ui.html) |
| 分析能力的说明和提示词 | [capabilities.mjs](capabilities.mjs) |
| 讨论阶段、HTTP 接口、历史保存和导出 | [server.mjs](server.mjs) |
| Codex / Claude 的模型与推理强度列表 | [providers.mjs](providers.mjs) |
| Cursor 的登录检查、模型列表或调用参数 | [cursor-provider.mjs](cursor-provider.mjs) |
| 验证 CLI 参数、失败处理和记录兼容性 | [集成测试](tests/integration.test.mjs) · [模拟 CLI](tests/mock-cli.mjs) |

## 提交改动

在自己的分支上完成改动，运行 `npm test`，然后向 `main` 提交 Pull Request。说明用户能观察到的变化，以及你验证了哪些场景。如果修复涉及特定的 CLI 输出或版本，请尽量用模拟 CLI 复现，方便其他贡献者在自己的机器上验证。

## Contributing in English

Bug reports, ideas, docs and code are welcome in English and Chinese. For a bug, share the CLI and Node.js versions, a short reproduction with a made-up prompt, and the expected and actual results. For a change, fork the repository, run `npm test` with Node.js 18 or newer, then open a pull request against `main` describing what changed and how you tested it. Tests run against local mock CLIs. For a manual model check, start the app with `npm start` and use your own signed-in CLI. [English quickstart](README.en.md) · [Security reports](SECURITY.md)
