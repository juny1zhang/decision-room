# Decision Room · 议事间

[中文](README.md) · English

Ask Codex, Claude Code and Cursor Agent the same question from one local browser window. Each participant can use a different model and take a different role. For a design decision, for example, ask one participant to compare the options and another to look for ways the proposed approach could fail. You can read their original answers, their reviews of each other’s reasoning and a summary from the moderator you choose.

![Decision Room in a browser](docs/images/decision-room.png)

## Run it on a Mac

Install Node.js 18 or newer and sign in to at least one of the supported command-line tools.

| Participant | CLI | Sign in |
| --- | --- | --- |
| Codex | `codex` | Run `codex login` and choose your ChatGPT account. |
| Claude Code | `claude` | Run `claude auth login` with your Claude account. |
| Cursor Agent | `cursor-agent` or `agent` | Run `agent login` with your Cursor account. |

```sh
git clone https://github.com/juny1zhang/decision-room.git
cd decision-room
npm start
```

The app uses Node.js built-in modules and starts directly from the clone. On macOS it opens the browser and prints a local URL in the terminal. Keep the terminal open while using the room. Press Ctrl+C to stop it. For subsequent sessions, you can also double-click `Start-Decision-Room.command`.

## Start your first discussion

The interface and discussion prompts are in Chinese. Select a mode in the message composer.

| Mode | What happens | CLI calls per completed round |
| --- | --- | --- |
| Single question · 单独提问 | One participant answers. | 1 |
| Independent answers · 分别回答 | Two or three participants answer before seeing each other’s responses. | 2 or 3 |
| Joint discussion · 联合讨论 | Each participant answers independently, then reviews all the answers. The chosen moderator summarizes points of agreement and disagreement. | 5 or 7 |

Open **模型与能力** (Models and capabilities) to choose participants, a model or custom model ID for each one, and an analysis focus such as planning, risk review or fact-checking. Available reasoning levels depend on the model. The web search checkbox controls whether participants can look up sources. Each CLI uses your account’s model access and quota.

Use **共同背景** (Shared context) to enter constraints that apply throughout the discussion, then send a question. You can change the participants for a follow-up. If a participant fails or you stop the round, completed answers remain in the room.

## Where the conversation goes

Your browser connects to a service on `127.0.0.1` using a port and access token generated at startup. Each selected CLI sends the question, shared context and up to about 48,000 characters of recent history to its model service. In a joint discussion, participants also receive each other’s answers for review.

Full transcripts are stored as JSON in `data/rooms/`, which Git ignores. Reopen a saved room from the sidebar or export it as Markdown. Set `DECISION_ROOM_DATA_DIR` to choose a different storage location.

## Check your setup

```sh
npm run check              # Check CLI login and available models without sending a question
npm test                   # Run integration tests with simulated CLIs
node server.mjs --no-open  # Print the local URL without opening a browser
```

Use `DECISION_ROOM_CODEX_BIN`, `DECISION_ROOM_CLAUDE_BIN` or `DECISION_ROOM_CURSOR_BIN` to point to a CLI installed in a custom location.

Live testing on macOS returned answers from Codex and Claude Code. Cursor login and model discovery succeeded, but its generation stream repeatedly disconnected in both Decision Room and the native CLI. If you encounter this, try `agent --mode ask` in an empty directory and send a short question to check your connection. The automated tests exercise all three adapters with simulated CLIs, including a full three-participant discussion.

## Get involved

- Share ideas and discuss how you use the app. [Discussions](https://github.com/juny1zhang/decision-room/discussions)
- Report a bug with a short reproduction. [Issues](https://github.com/juny1zhang/decision-room/issues)
- Send a change to the code or documentation. [Contributing guide](CONTRIBUTING.md)
- Report a security concern privately. [Security reporting instructions](SECURITY.md)

Decision Room is distributed under the [MIT License](LICENSE).
