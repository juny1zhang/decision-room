// Why an official CLI failed: a category a caller can act on (a 'network' failure may be retried once) and
// a message for people that never repeats the CLI's output, which may echo the entire prompt, account
// details or the process environment.
import { AppError } from './errors.mjs';

/** The failure categories, as found on the `category` of errors thrown for a failed provider call. */
export const FAILURE_CATEGORIES = Object.freeze(['quota', 'auth', 'cli', 'model', 'network', 'other']);

const NETWORK_MESSAGE = '未能连接官方模型服务，请检查本机网络和证书设置。';

// Checked in order; the first matching pattern wins. Certificate problems come first: their messages may
// also mention an expiry, which would otherwise read as an expired login.
const FAILURES = [
  ['network', /certificate|self[- ]signed|tls handshake/i, NETWORK_MESSAGE],
  [
    'quota',
    /rate.?limit|usage.?limit|quota|out of credits|limit reached|usage cap|too many requests|credit balance/i,
    '套餐额度或速率限制已触发。请在对应官方工具查看用量，稍后再试；本应用不会自动切换 API。'
  ],
  [
    'auth',
    /not logged|unauth|authentication|login|sign in|expired|\b401\b/i,
    '登录无效或已过期。请在终端重新登录对应官方 CLI，再点击重新检查。'
  ],
  [
    'cli',
    /unknown option|unexpected argument|unrecognized|unknown feature/i,
    '当前 CLI 版本不支持所需参数。请按官方安装文档更新后重试。'
  ],
  [
    'model',
    /invalid.model|model.{0,60}(?:unsupported|not supported|unavailable|not found|not available)|not have access to.{0,30}model/i,
    '当前账号或 CLI 无法使用所选模型，请检查模型 ID 或改用默认模型。'
  ],
  [
    'network',
    /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|getaddrinfo|network error|network is unreachable|fetch failed|could not connect|unable to connect|connection (?:error|reset|refused|closed)|error sending request|stream disconnected|socket hang up|request timed out/i,
    NETWORK_MESSAGE
  ]
];

/** The text of an error a CLI reported in its structured output: a string or an object with a message. */
export function errorText(value) {
  if (typeof value === 'string') return value;
  return typeof value?.message === 'string' ? value.message : '';
}

/**
 * Classifies a failed CLI run as { category, message }. Only error output is read: `stderr` and `errors`,
 * the error messages the CLI reported in its structured output. Never pass stdout: it holds the model's own
 * text, and an answer that mentions a quota or a login must not be taken for a quota or login failure.
 * `code` is the exit code, named when nothing more specific is known.
 */
export function classifyFailure({ code, stderr = '', errors = [] }) {
  const text = [stderr, ...errors.map(errorText)].join('\n');
  for (const [category, pattern, message] of FAILURES) if (pattern.test(text)) return { category, message };
  return {
    category: 'other',
    message: `官方 CLI 未成功完成（退出码 ${code ?? '未知'}）。请在对应 CLI 中检查所选模型、账号权限和网络。`
  };
}

/** classifyFailure's message alone, for the CLI checks (version, help) that report a text. */
export function diagnosticFailure(result) {
  return classifyFailure(result).message;
}

/** The error a provider throws for a failed call: an AppError that carries the failure's `category`. */
export function failureError({ category, message }) {
  const error = new AppError(message);
  error.category = category;
  return error;
}
