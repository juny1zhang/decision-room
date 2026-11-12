// Failure messages for official CLIs, checked in order; the first matching pattern wins.
const FAILURES = [
  [
    /rate.?limit|usage.?limit|quota|out of credits|limit reached|usage cap/i,
    '套餐额度或速率限制已触发。请在对应官方工具查看用量，稍后再试；本应用不会自动切换 API。'
  ],
  [
    /not logged|unauth|authentication|login|sign in|expired|401/i,
    '登录无效或已过期。请在终端重新登录对应官方 CLI，再点击重新检查。'
  ],
  [
    /unknown option|unexpected argument|unrecognized|unknown feature/i,
    '当前 CLI 版本不支持所需参数。请按官方安装文档更新后重试。'
  ],
  [
    /invalid.model|model.{0,60}(?:unsupported|not supported|unavailable|not found|not available)|not have access to.{0,30}model/i,
    '当前账号或 CLI 无法使用所选模型，请检查模型 ID 或改用默认模型。'
  ],
  [
    /certificate|ECONN|ETIMEDOUT|network error|fetch failed|could not connect|unable to connect/i,
    '未能连接官方模型服务，请检查本机网络和证书设置。'
  ]
];

/**
 * Explains why an official CLI failed ({ code, stderr, stdout }) without repeating its output: a CLI may
 * echo the entire prompt, account details or process environment on failure.
 */
export function diagnosticFailure(result) {
  const text = `${result.stderr}\n${result.stdout}`;
  for (const [pattern, message] of FAILURES) if (pattern.test(text)) return message;
  return `官方 CLI 未成功完成（退出码 ${result.code}）。请在对应 CLI 中检查所选模型、账号权限和网络。`;
}
