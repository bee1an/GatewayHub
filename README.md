# GatewayHub

本地多网关桌面控制台。当前版本已内置 TypeScript Kiro provider，并预留 Codex / Gemini provider 扩展位。

## 功能

- 本地 HTTP 网关：默认 `http://127.0.0.1:8000`
- OpenAI 兼容：`/v1/models`、`/v1/chat/completions`
- Anthropic 兼容：`/v1/messages`、`/v1/messages/count_tokens`
- Kiro 账号池：自动发现、CLI 登录、Token 粘贴、JSON 导入
- 自动 token refresh、SSE 流式、工具调用、图片输入、账号失败切换
- 全局模型映射：把任意 alias 路由到指定 provider + 真实 model
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
    "model":"kiro/claude-sonnet-4-5",
    "messages":[{"role":"user","content":"你好"}],
    "stream":true
  }'
```

`model` 字段必须使用 `provider/model` 格式（如 `kiro/claude-sonnet-4-5`）。
裸 model id 会被拒绝，除非命中「模型映射」中定义的别名 —— 该页可以把任意 alias
（例如 `gpt-4`）路由到指定 provider 与真实 model，便于客户端统一调用入口。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
```

## CLI

完整的命令行工具文档见 [src/cli/README.md](src/cli/README.md)。

## 安装与信任

### macOS

#### 推荐：通过 Homebrew 安装

```bash
brew tap bee1an/gatewayhub
brew install --cask gatewayhub
```

升级：

```bash
brew upgrade --cask gatewayhub
```

通过 Homebrew 安装的版本，应用内检测到新版本后点击「使用 Homebrew 更新」会自动打开终端执行升级命令并重启应用。

#### 手动安装

1. 从 [Releases](https://github.com/bee1an/GatewayHub/releases) 下载最新 `.dmg`
2. 拖入 Applications 文件夹
3. 首次打开会被 Gatekeeper 拦截，执行以下任一操作：

   **方式 A（推荐）：**

   ```bash
   xattr -cr /Applications/GatewayHub.app
   ```

   **方式 B：**
   系统设置 → 隐私与安全性 → 下方找到被拦截的 GatewayHub → 点击"仍要打开"

> 手动安装的版本不支持应用内自动更新，新版本会引导跳转到 GitHub Release 页面手动下载。

### Windows

1. 从 Releases 下载 `.exe` 安装包
2. 首次运行可能弹出 SmartScreen 警告，点击"更多信息" → "仍要运行"
3. 后续自动更新不会再弹窗

### Linux

从 Releases 下载 `.AppImage` / `.deb` / `.snap`，直接运行即可。

## 自动更新

应用启动时会自动检查 GitHub Releases 上的新版本。

- **macOS（通过 Homebrew 安装）**：在弹框点击「使用 Homebrew 更新」即可，会自动打开终端运行 `brew upgrade --cask gatewayhub` 并重启应用
- **macOS（手动安装）/ Windows / Linux**：弹框会引导跳转到 [GitHub Releases](https://github.com/bee1an/GatewayHub/releases) 手动下载新版本

更新源：`https://github.com/bee1an/GatewayHub/releases`
