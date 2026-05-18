# GatewayHub

本地多网关桌面控制台。当前版本已内置 TypeScript Kiro provider，并预留 Codex / Gemini provider 扩展位。

## 功能

- 本地 HTTP 网关：默认 `http://127.0.0.1:8000`
- OpenAI 兼容：`/v1/models`、`/v1/chat/completions`
- Anthropic 兼容：`/v1/messages`、`/v1/messages/count_tokens`
- Kiro 账号池：自动发现、CLI 登录、Token 粘贴、JSON 导入
- 自动 token refresh、SSE 流式、工具调用、图片输入、账号失败切换
- 配置文件：`~/.config/gatewayhub/gatewayhub.config.json`
- 账号文件：`~/.config/gatewayhub/kiro/accounts/*.json`

## 开发运行

```bash
pnpm install
pnpm dev
```

首次启动会自动尝试发现：

- `~/.aws/sso/cache/kiro-auth-token.json`
- `~/.aws/sso/cache/*.json`
- `~/.local/share/kiro-cli/data.sqlite3`
- `~/.local/share/amazon-q/data.sqlite3`

也可以在 UI 中点击”添加账号”手动添加。

## API 示例

```bash
curl http://127.0.0.1:8000/v1/chat/completions \
  -H "Authorization: Bearer <UI 中显示的 API Key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"claude-sonnet-4.5",
    "messages":[{"role":"user","content":"你好"}],
    "stream":true
  }'
```

使用 `kiro/claude-sonnet-4.5` 可显式指定 Kiro provider；无前缀默认走 Kiro。

## 验证

```bash
pnpm typecheck
pnpm build
```
