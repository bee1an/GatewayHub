# GatewayHub

本地多网关桌面应用（macOS,GPUI + Rust)。内置多 provider 账号池与统一 OpenAI/Anthropic/Responses 兼容 HTTP 网关。

## 功能

- 本地 HTTP 网关：`http://127.0.0.1:9741`（可在配置中修改）
- OpenAI 兼容：`/v1/models`、`/v1/chat/completions`、`/v1/responses`
- Anthropic 兼容：`/v1/messages`、`/v1/messages/count_tokens`
- Provider：kiro、codex、windsurf、trae、traework、workbuddy、qoder、nvidia、openrouter、gptWeb、grokWeb、geminiWeb
- 账号池：token 自动刷新、失败分类、冷却与轮换、每日签到（traework / workbuddy)
- 全局模型映射：把任意 alias 路由到指定 provider + 真实 model
- 用量与请求日志（usage store 按天聚合）
- 配置文件：`~/.config/gatewayhub/gatewayhub.config.json`
- 账号文件：`~/.config/gatewayhub/<provider>/accounts/*.json`

## 构建与运行

```bash
cargo build
cargo run --bin gatewayhub
```

测试：

```bash
cargo test -p gateway-core
```
