import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Local process fixtures. These never contact a model or inspect real credentials.
export async function runMock(provider, wrapperUrl) {
  const dir = path.dirname(fileURLToPath(wrapperUrl));
  const controlPath = path.join(dir, 'control.json');
  const control = fs.existsSync(controlPath) ? JSON.parse(fs.readFileSync(controlPath, 'utf8')) : {};
  const args = process.argv.slice(2);
  const settings = control[provider] || {};
  if (args.includes('--version') || args.includes('-V')) {
    const versions = { codex: 'codex-cli 0.167.0', claude: '2.1.300 (Claude Code)', cursor: '2026.11.08-mock' };
    process.stdout.write(versions[provider] + '\n');
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    const help = {
      codex: '--ignore-user-config --model --json --output-last-message -o --sandbox --skip-git-repo-check --ephemeral --search --config --ask-for-approval',
      claude: '--safe-mode --model <model> --no-session-persistence --setting-sources --mcp-config --strict-mcp-config --disable-slash-commands --tools --allowedTools --permission-mode --max-turns --input-format --output-format\n  --effort <level>  Effort level for the current session\n                    (low, medium, high, xhigh, max)\n',
      cursor: '--mode <mode> (choices: "plan", "ask") --workspace --model --sandbox --list-models --print --output-format --format',
    };
    process.stdout.write(help[provider] + '\n');
    return;
  }
  if (provider === 'codex' && args.includes('debug') && args.includes('models')) {
    const supported = ['low', 'medium', 'high'].map(effort => ({effort, description: effort}));
    process.stdout.write(JSON.stringify({models: [{
      slug: 'mock-codex', visibility: 'list', supported_in_api: true,
      supported_reasoning_levels: supported, default_reasoning_level: 'medium',
    }]}));
    return;
  }
  if (provider === 'codex' && args.includes('login') && args.includes('status')) {
    process.stderr.write(settings.auth === 'api' ? 'Logged in using an API key\n' : settings.auth === 'none' ? 'Not logged in\n' : 'Logged in using ChatGPT\n');
    process.exitCode = settings.auth === 'none' ? 1 : 0;
    return;
  }
  if (provider === 'claude' && args.includes('auth') && args.includes('status')) {
    process.stdout.write(JSON.stringify({ loggedIn: settings.auth !== 'none', authMethod: settings.auth === 'api' ? 'api_key' : settings.auth === 'oauth' ? 'oauth_token' : settings.auth === 'third_party' ? 'third_party' : settings.auth === 'none' ? 'none' : 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro', email: 'private-user@example.invalid', configDirectory: '/private/example' }) + '\n');
    process.exitCode = settings.auth === 'none' ? 1 : 0;
    return;
  }
  if (provider === 'claude' && args.includes('--input-format') && args.includes('stream-json')) {
    const supportedEffortLevels = ['low', 'medium', 'high'];
    const models = [
      {value:'default', resolvedModel:'mock-claude-default', supportedEffortLevels},
      {value:'sonnet', resolvedModel:'mock-claude-sonnet', supportedEffortLevels},
      {value:'haiku', resolvedModel:'mock-claude-fast', supportsEffort:false},
    ];
    process.stdout.write(JSON.stringify({type:'control_response',response:{
      request_id:'models', subtype:'success', response:{models},
    }}) + '\n');
    return;
  }
  if (provider === 'cursor' && (args.includes('status') || args.includes('whoami'))) {
    const authenticated = settings.auth !== 'none';
    process.stdout.write(JSON.stringify({
      status: authenticated ? 'authenticated' : 'unauthenticated',
      isAuthenticated: authenticated, hasAccessToken: authenticated, hasRefreshToken: authenticated,
      message: authenticated ? 'Logged in as private-user@example.invalid' : 'Not logged in',
    }));
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
  const count = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  const result = `MOCK_${provider.toUpperCase()}_RESULT_${count + 1}`;
  const authOverrides = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN', 'CURSOR_API_ENDPOINT'];
  let cursorConfig;
  if (provider === 'cursor' && process.env.CURSOR_CONFIG_DIR) {
    const config = JSON.parse(fs.readFileSync(path.join(process.env.CURSOR_CONFIG_DIR, 'cli-config.json')));
    cursorConfig = {permissions: config.permissions, autoAcceptWebSearch: config.autoAcceptWebSearch, sandbox: config.sandbox};
  }
  fs.appendFileSync(logPath, JSON.stringify({ provider, args, prompt, result, pid: process.pid, cursorConfig, apiEnvNames: authOverrides.filter(k => process.env[k]), time: Date.now() }) + '\n');
  process.on('SIGTERM', () => {
    fs.appendFileSync(path.join(dir, 'terminated.ndjson'), JSON.stringify({ provider, pid: process.pid }) + '\n');
    process.exit(0);
  });
  if (settings.hang) await new Promise(() => { setInterval(() => {}, 1000); });
  if (settings.fail) {
    process.stderr.write(`MOCK_${provider.toUpperCase()}_FAILURE\n`);
    process.exitCode = 1;
    return;
  }
  if (settings.empty) return;
  if (settings.delayMs) await new Promise(resolve => setTimeout(resolve, settings.delayMs));
  if (provider === 'codex') {
    const outputIndex = args.findIndex(x => x === '-o' || x === '--output-last-message');
    if (outputIndex !== -1 && args[outputIndex + 1]) fs.writeFileSync(args[outputIndex + 1], result);
    process.stdout.write(JSON.stringify({type:'thread.started', thread_id:'fake-codex-thread', model:'mock-codex-actual'}) + '\n');
    process.stdout.write(JSON.stringify({type:'turn.started'}) + '\n');
    process.stdout.write(JSON.stringify({type:'item.completed',item:{id:'agent-1',type:'agent_message',text:result}}) + '\n');
    process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:10}}) + '\n');
  } else if (provider === 'claude') {
    process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result,session_id:'fake-claude-session',modelUsage:{'mock-claude':{inputTokens:10,outputTokens:10}},total_cost_usd:0}) + '\n');
  } else {
    process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result,session_id:'fake-cursor-session'}) + '\n');
  }
}
