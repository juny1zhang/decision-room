import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const writeEvent = (event) => process.stdout.write(JSON.stringify(event) + '\n');

/** `text` cut into `count` pieces of about the same length, which join to it again. */
function pieces(text, count = 3) {
  const size = Math.ceil(text.length / count);
  const parts = [];
  for (let start = 0; start < text.length; start += size) parts.push(text.slice(start, start + size));
  return parts;
}

// Token counts the mock CLIs report, as each CLI names them.
export const MOCK_USAGE = {
  // Codex counts cached tokens as input: 12,345 in all, 2,048 of them cached.
  codex: { input_tokens: 12345, cached_input_tokens: 2048, output_tokens: 1234 },
  // Claude lists cache reads and writes beside the input: 20 + 300 + 4,000 = 4,320 in all.
  claude: {
    input_tokens: 20,
    cache_creation_input_tokens: 300,
    cache_read_input_tokens: 4000,
    output_tokens: 456
  }
};

// Local process fixtures. These never contact a model or inspect real credentials.
//
// control.json steers them, per provider: auth ('api', 'oauth', 'third_party', 'none'), fail, failure
// ({ answer, stderr, code }), failOnce ({ stderr, code = 1, times = 1, after = 0 }: that provider's model
// calls after the first `after` fail with `stderr`, `times` of them, and later ones answer; counted in
// fail-once-<provider>.count), answer (the
// text of every answer instead of MOCK_<PROVIDER>_RESULT_<n>), hang, empty, delayMs (before answering),
// expiredCatalog (Cursor), and for streaming: noStreamFlags (help without the streaming flags, as an older
// CLI) and streamDelayMs (the pause before each streamed piece, 20 ms by default). With the flags in its
// help the app asks Claude and Cursor for stream-json output; Codex always streams its --json events, with
// item.updated previews unless noStreamFlags is set. For goal mode, verdicts sets the line a feedback answer
// (a prompt that asks for a review of a version of the plan) ends with, by that provider's feedback calls in
// order, failed ones included: 'approve' (结论：认可), 'revise' (结论：需修改), anything else for none; the
// last entry repeats, a single string stands for every call, and without it a feedback has no verdict line
// (which counts as 需修改). Counted in verdicts-<provider>.count.
export async function runMock(provider, wrapperUrl) {
  const dir = path.dirname(fileURLToPath(wrapperUrl));
  const controlPath = path.join(dir, 'control.json');
  const control = fs.existsSync(controlPath) ? JSON.parse(fs.readFileSync(controlPath, 'utf8')) : {};
  const args = process.argv.slice(2);
  const settings = control[provider] || {};
  // Every invocation, checks included, so tests can count the processes a step starts.
  fs.appendFileSync(
    path.join(dir, 'spawns.ndjson'),
    JSON.stringify({ provider, args, time: Date.now() }) + '\n'
  );
  if (args.includes('--version') || args.includes('-V')) {
    const versions = {
      codex: 'codex-cli 0.167.0',
      claude: '2.1.300 (Claude Code)',
      cursor: '2026.11.08-mock'
    };
    process.stdout.write(versions[provider] + '\n');
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    const streamFlags = settings.noStreamFlags
      ? ''
      : { codex: '', claude: ' --verbose --include-partial-messages', cursor: ' --stream-partial-output' }[
          provider
        ];
    const help = {
      codex:
        '--ignore-user-config --model --json --output-last-message -o --sandbox --skip-git-repo-check --ephemeral --search --config --ask-for-approval',
      claude:
        '--safe-mode --model <model> --no-session-persistence --setting-sources --mcp-config --strict-mcp-config --disable-slash-commands --tools --allowedTools --permission-mode --max-turns --input-format --output-format' +
        streamFlags +
        '\n  --effort <level>  Effort level for the current session\n                    (low, medium, high, xhigh, max)\n',
      cursor:
        '--mode <mode> (choices: "plan", "ask") --workspace --trust --model --sandbox --list-models --print --output-format --format' +
        streamFlags
    };
    process.stdout.write(help[provider] + '\n');
    return;
  }
  if (provider === 'codex' && args.includes('debug') && args.includes('models')) {
    const supported = ['low', 'medium', 'high'].map((effort) => ({ effort, description: effort }));
    process.stdout.write(
      JSON.stringify({
        models: [
          {
            slug: 'mock-codex',
            visibility: 'list',
            supported_in_api: true,
            supported_reasoning_levels: supported,
            default_reasoning_level: 'medium'
          }
        ]
      })
    );
    return;
  }
  if (provider === 'codex' && args.includes('login') && args.includes('status')) {
    process.stderr.write(
      settings.auth === 'api'
        ? 'Logged in using an API key\n'
        : settings.auth === 'none'
          ? 'Not logged in\n'
          : 'Logged in using ChatGPT\n'
    );
    process.exitCode = settings.auth === 'none' ? 1 : 0;
    return;
  }
  if (provider === 'claude' && args.includes('auth') && args.includes('status')) {
    process.stdout.write(
      JSON.stringify({
        loggedIn: settings.auth !== 'none',
        authMethod:
          settings.auth === 'api'
            ? 'api_key'
            : settings.auth === 'oauth'
              ? 'oauth_token'
              : settings.auth === 'third_party'
                ? 'third_party'
                : settings.auth === 'none'
                  ? 'none'
                  : 'claude.ai',
        apiProvider: 'firstParty',
        subscriptionType: 'pro',
        email: 'private-user@example.invalid',
        configDirectory: '/private/example'
      }) + '\n'
    );
    process.exitCode = settings.auth === 'none' ? 1 : 0;
    return;
  }
  if (provider === 'claude' && args.includes('--input-format') && args.includes('stream-json')) {
    const supportedEffortLevels = ['low', 'medium', 'high'];
    const models = [
      { value: 'default', resolvedModel: 'mock-claude-default', supportedEffortLevels },
      { value: 'sonnet', resolvedModel: 'mock-claude-sonnet', supportedEffortLevels },
      { value: 'haiku', resolvedModel: 'mock-claude-fast', supportsEffort: false }
    ];
    process.stdout.write(
      JSON.stringify({
        type: 'control_response',
        response: {
          request_id: 'models',
          subtype: 'success',
          response: { models }
        }
      }) + '\n'
    );
    return;
  }
  if (provider === 'cursor' && (args.includes('status') || args.includes('whoami'))) {
    const authenticated = settings.auth !== 'none';
    process.stdout.write(
      JSON.stringify({
        status: authenticated ? 'authenticated' : 'unauthenticated',
        isAuthenticated: authenticated,
        hasAccessToken: authenticated,
        hasRefreshToken: authenticated,
        message: authenticated ? 'Logged in as private-user@example.invalid' : 'Not logged in'
      })
    );
    process.exitCode = authenticated ? 0 : 1;
    return;
  }
  if (provider === 'cursor' && (args.includes('models') || args.includes('--list-models'))) {
    if (settings.expiredCatalog) {
      process.stderr.write("Error: Authentication required. Run 'agent login'.\n");
      process.exitCode = 1;
    } else {
      process.stdout.write('Available models\n\nmock-cursor - Mock Cursor\nauto - Auto (default)\n');
    }
    return;
  }
  if (!(provider === 'codex' ? args.includes('exec') : args.includes('-p') || args.includes('--print'))) {
    process.stderr.write('Unexpected mock command\n');
    process.exitCode = 2;
    return;
  }
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  const logPath = path.join(dir, 'calls.ndjson');
  const count = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).length
    : 0;
  let result =
    typeof settings.answer === 'string'
      ? settings.answer
      : `MOCK_${provider.toUpperCase()}_RESULT_${count + 1}`;
  if (settings.verdicts !== undefined && /的身份评审方案 v\d+/.test(prompt)) {
    const verdicts = [settings.verdicts].flat();
    const counter = path.join(dir, `verdicts-${provider}.count`);
    const number = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
    fs.writeFileSync(counter, String(number + 1));
    const verdict = { approve: '结论：认可', revise: '结论：需修改' }[
      verdicts[Math.min(number, verdicts.length - 1)]
    ];
    if (verdict) result += `\n\n${verdict}`;
  }
  const authOverrides = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'CODEX_ACCESS_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CURSOR_API_KEY',
    'CURSOR_AUTH_TOKEN',
    'CURSOR_API_ENDPOINT'
  ];
  let cursorConfig;
  if (provider === 'cursor' && process.env.CURSOR_CONFIG_DIR) {
    const config = JSON.parse(fs.readFileSync(path.join(process.env.CURSOR_CONFIG_DIR, 'cli-config.json')));
    cursorConfig = {
      permissions: config.permissions,
      autoAcceptWebSearch: config.autoAcceptWebSearch,
      sandbox: config.sandbox
    };
  }
  fs.appendFileSync(
    logPath,
    JSON.stringify({
      provider,
      args,
      prompt,
      result,
      pid: process.pid,
      cursorConfig,
      apiEnvNames: authOverrides.filter((k) => process.env[k]),
      time: Date.now()
    }) + '\n'
  );
  process.on('SIGTERM', () => {
    fs.appendFileSync(
      path.join(dir, 'terminated.ndjson'),
      JSON.stringify({ provider, pid: process.pid }) + '\n'
    );
    process.exit(0);
  });
  if (settings.hang)
    await new Promise(() => {
      setInterval(() => {}, 1000);
    });
  if (settings.fail) {
    process.stderr.write(`MOCK_${provider.toUpperCase()}_FAILURE\n`);
    process.exitCode = 1;
    return;
  }
  if (settings.failOnce) {
    const { stderr = '', code = 1, times = 1, after = 0 } = settings.failOnce;
    const counter = path.join(dir, `fail-once-${provider}.count`);
    const number = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
    fs.writeFileSync(counter, String(number));
    if (number > after && number <= after + times) {
      process.stderr.write(stderr + '\n');
      process.exitCode = code;
      return;
    }
  }
  if (settings.failure) {
    // A call that fails after the model wrote `answer` (in the CLI's own output format), with `stderr`.
    const { answer = '', stderr = '', code = 1 } = settings.failure;
    const output =
      provider === 'codex'
        ? { type: 'item.completed', item: { id: 'agent-1', type: 'agent_message', text: answer } }
        : { type: 'result', subtype: 'success', is_error: false, result: answer };
    process.stdout.write(JSON.stringify(output) + '\n');
    process.stderr.write(stderr + '\n');
    process.exitCode = code;
    return;
  }
  if (settings.empty) return;
  if (settings.delayMs) await sleep(settings.delayMs);
  const streamDelay = settings.streamDelayMs ?? 20;
  const stream = args[args.indexOf('--output-format') + 1] === 'stream-json';
  if (provider === 'codex') {
    const outputIndex = args.findIndex((x) => x === '-o' || x === '--output-last-message');
    if (outputIndex !== -1 && args[outputIndex + 1]) fs.writeFileSync(args[outputIndex + 1], result);
    writeEvent({ type: 'thread.started', thread_id: 'fake-codex-thread', model: 'mock-codex-actual' });
    writeEvent({ type: 'turn.started' });
    if (!settings.noStreamFlags) {
      const reasoning = { id: 'reasoning-1', type: 'reasoning', text: '' };
      writeEvent({ type: 'item.started', item: reasoning });
      writeEvent({ type: 'item.completed', item: { ...reasoning, text: '**Weighing the options**' } });
      let text = '';
      for (const piece of pieces(result)) {
        await sleep(streamDelay);
        text += piece;
        writeEvent({ type: 'item.updated', item: { id: 'agent-1', type: 'agent_message', text } });
      }
    }
    writeEvent({ type: 'item.completed', item: { id: 'agent-1', type: 'agent_message', text: result } });
    writeEvent({ type: 'turn.completed', usage: MOCK_USAGE.codex });
    return;
  }
  const modelUsage = {
    'mock-claude': {
      inputTokens: MOCK_USAGE.claude.input_tokens,
      outputTokens: MOCK_USAGE.claude.output_tokens,
      cacheReadInputTokens: MOCK_USAGE.claude.cache_read_input_tokens,
      cacheCreationInputTokens: MOCK_USAGE.claude.cache_creation_input_tokens
    }
  };
  const final =
    provider === 'claude'
      ? {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result,
          duration_ms: 1234,
          session_id: 'fake-claude-session',
          usage: MOCK_USAGE.claude,
          modelUsage,
          total_cost_usd: 0
        }
      : {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result,
          duration_ms: 1234,
          session_id: 'fake-cursor-session'
        };
  if (stream && provider === 'claude') {
    // Claude Code's stream-json with --include-partial-messages; an unknown event and a noisy line too.
    writeEvent({ type: 'system', subtype: 'init', model: 'mock-claude', session_id: 'fake-claude-session' });
    writeEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
    process.stdout.write('not json at all\n');
    const partial = (event) => writeEvent({ type: 'stream_event', event, parent_tool_use_id: null });
    partial({ type: 'message_start', message: { model: 'mock-claude', content: [] } });
    partial({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    partial({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '…' } });
    partial({ type: 'content_block_stop', index: 0 });
    partial({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    for (const piece of pieces(result)) {
      await sleep(streamDelay);
      partial({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: piece } });
    }
    partial({ type: 'content_block_stop', index: 1 });
    writeEvent({ type: 'assistant', message: { content: [{ type: 'text', text: result }] } });
    partial({ type: 'message_stop' });
  } else if (stream) {
    // Cursor Agent's stream-json with --stream-partial-output, which repeats the whole message at the end.
    writeEvent({ type: 'system', subtype: 'init', session_id: 'fake-cursor-session' });
    writeEvent({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } });
    writeEvent({ type: 'thinking', subtype: 'delta', text: '…' });
    writeEvent({ type: 'thinking', subtype: 'completed' });
    const assistant = (text) =>
      writeEvent({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
    for (const piece of pieces(result)) {
      await sleep(streamDelay);
      assistant(piece);
    }
    assistant(result);
  }
  writeEvent(final);
}
