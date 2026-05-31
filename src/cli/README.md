# GatewayHub CLI

GatewayHub 提供完整的命令行工具，与 GUI 共用同一份后端代码和配置文件，可独立运行。

## 安装

```bash
# 开发环境直接运行
node out/main/cli.js <command>

# 或通过 pnpm script
pnpm cli <command>

# 安装到 PATH（创建 ~/.local/bin/gatewayhub 软链）
pnpm cli shell install-shim
```

## 全局选项

| 选项            | 说明                           |
| --------------- | ------------------------------ |
| `--json`        | 输出 JSON 格式（适合脚本消费） |
| `--no-color`    | 禁用颜色输出                   |
| `-v, --version` | 显示版本号                     |
| `-h, --help`    | 显示帮助信息                   |

## 命令列表

### gateway — 网关生命周期

| 命令                                              | 说明                                              |
| ------------------------------------------------- | ------------------------------------------------- |
| `gateway status`                                  | 显示网关运行状态、提供商信息、账号数量            |
| `gateway start [--host <host>] [--port <port>]`   | 以后台 daemon 模式启动网关（默认 127.0.0.1:8000） |
| `gateway stop`                                    | 停止后台 daemon                                   |
| `gateway restart [--host <host>] [--port <port>]` | 重启 daemon                                       |
| `gateway health`                                  | 探测网关 /health 端点是否正常                     |

### account — 账号管理

| 命令                                                 | 说明                                   |
| ---------------------------------------------------- | -------------------------------------- |
| `account list`                                       | 列出所有 Kiro 账号及状态               |
| `account info <id>`                                  | 查看账号详细信息（邮箱、订阅、配额等） |
| `account test <id>`                                  | 测试账号连接是否正常                   |
| `account enable <id>`                                | 启用账号                               |
| `account disable <id>`                               | 禁用账号                               |
| `account remove <id>`                                | 删除账号                               |
| `account reset <id>`                                 | 重置账号状态（清除失败计数和冷却）     |
| `account set-status <id> <status> [--reason <text>]` | 手动设置账号状态                       |
| `account scan`                                       | 扫描系统中可导入的候选账号             |
| `account auto-discover`                              | 自动发现并导入新账号                   |

### account-import — 账号导入

| 命令                                                   | 说明                                            |
| ------------------------------------------------------ | ----------------------------------------------- |
| `account-import token <text> [--type refresh\|access]` | 导入 refresh/access token（默认 refresh）       |
| `account-import json [<path\|->]`                      | 从 JSON 文件或 stdin 批量导入账号               |
| `account-import scanned <id...>`                       | 导入 scan 命令发现的候选账号                    |
| `account-import kiro-cli [--cli-path <path>]`          | 通过 kiro-cli 交互式登录导入账号（Ctrl-C 取消） |

### trae — Trae 国际服账号与探测

| 命令                                                      | 说明                                              |
| --------------------------------------------------------- | ------------------------------------------------- |
| `trae list`                                               | 列出已导入的 Trae 国际服账号                      |
| `trae scan`                                               | 扫描本机 Trae 国际服本地登录态候选                |
| `trae import-token [token] [--type refresh\|jwt]`         | 导入 refresh token 或 Cloud-IDE-JWT（支持 stdin） |
| `trae import-json [<path\|->]`                            | 从 Trae auth JSON、storage JSON 或 stdin 导入     |
| `trae import-scanned <id...>`                             | 导入 `trae scan` 发现的候选账号                   |
| `trae test <id>`                                          | 测试账号、刷新 JWT 并拉取用户信息/模型列表        |
| `trae info <id>`                                          | 查看账号运行态详情                                |
| `trae refresh-models <id>`                                | 重新拉取 Trae IDE model_list                      |
| `trae enable\|disable\|remove\|reset <id>`                | 启用、禁用、删除或重置账号状态                    |
| `trae set-status <id> <status> [--reason <text>]`         | 手动设置账号状态                                  |
| `trae chat [prompt] [--model <model>] [--max-tokens <n>]` | 通过本地网关发起一次 Trae raw chat 冒烟测试       |

### openrouter — OpenRouter Key 账号池

| 命令                                                            | 说明                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------- |
| `openrouter list`                                               | 列出已导入的 OpenRouter key 与免费/付费层级                       |
| `openrouter import-key [key]`                                   | 导入并立即校验 OpenRouter API key，自动刷新可用模型（支持 stdin） |
| `openrouter import-json [<path\|->]`                            | 从包含 apiKey/key 的 JSON 文件或 stdin 批量导入并尝试校验         |
| `openrouter test <id>`                                          | 调用 `/key` 校验 key，按免费/付费层级刷新可用模型                 |
| `openrouter info <id>`                                          | 查看 key 运行态详情与模型列表                                     |
| `openrouter refresh-models <id>`                                | 重新拉取 OpenRouter 模型列表并应用 key 层级过滤                   |
| `openrouter enable\|disable\|remove\|reset <id>`                | 启用、禁用、删除或重置 key 状态                                   |
| `openrouter set-status <id> <status> [--reason <text>]`         | 手动设置 key 状态                                                 |
| `openrouter chat [prompt] [--model <model>] [--max-tokens <n>]` | 通过本地网关发起一次 OpenRouter chat 冒烟测试，默认走免费路由     |

### nvidia — NVIDIA NIM API Key 账号池

| 命令                                                        | 说明                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------- |
| `nvidia list`                                               | 列出已导入的 NVIDIA NIM API key                               |
| `nvidia import-key [key]`                                   | 导入并立即校验 NVIDIA API key，自动刷新可用模型（支持 stdin） |
| `nvidia import-json [<path\|->]`                            | 从包含 apiKey/key 的 JSON 文件或 stdin 批量导入并尝试校验     |
| `nvidia test <id>`                                          | 通过一次最小 chat 请求校验 key，并刷新 /models 模型列表       |
| `nvidia info <id>`                                          | 查看 key 运行态详情与模型列表                                 |
| `nvidia refresh-models <id>`                                | 重新拉取 NVIDIA `/models` 模型列表                            |
| `nvidia enable\|disable\|remove\|reset <id>`                | 启用、禁用、删除或重置 key 状态                               |
| `nvidia set-status <id> <status> [--reason <text>]`         | 手动设置 key 状态                                             |
| `nvidia chat [prompt] [--model <model>] [--max-tokens <n>]` | 通过本地网关发起一次 NVIDIA OpenAI 兼容 chat 冒烟测试         |

### apikey — API 密钥管理

| 命令                                                                                    | 说明              |
| --------------------------------------------------------------------------------------- | ----------------- |
| `apikey list`                                                                           | 列出所有 API 密钥 |
| `apikey create [--name <name>] [--expires <iso>] [--scopes <a,b>]`                      | 生成新密钥        |
| `apikey revoke <id>`                                                                    | 撤销密钥          |
| `apikey update <id> [--name] [--expires] [--scopes] [--clear-expires] [--clear-scopes]` | 更新密钥属性      |

### mapping — 模型映射

| 命令                                                                                | 说明                 |
| ----------------------------------------------------------------------------------- | -------------------- |
| `mapping list`                                                                      | 列出所有模型别名映射 |
| `mapping set <alias> --provider <p> --model <m> [--note <text>] [--enabled <bool>]` | 创建或更新映射       |
| `mapping remove <alias>`                                                            | 删除映射             |

### model — 模型列表

| 命令         | 说明                             |
| ------------ | -------------------------------- |
| `model list` | 列出所有可用模型（含提供商前缀） |

### provider — 提供商配置

| 命令                                  | 说明                           |
| ------------------------------------- | ------------------------------ |
| `provider route <type> <name>`        | 设置提供商路由名称（URL 前缀） |
| `provider display-name <type> <text>` | 设置提供商显示名称             |

### settings — 设置管理

| 命令                                     | 说明                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `settings kiro show`                     | 显示 Kiro 提供商设置                                                 |
| `settings kiro set <key=value...>`       | 修改 Kiro 设置（如 `vpnProxyUrl=http://...`）                        |
| `settings trae show`                     | 显示 Trae 国际服提供商设置                                           |
| `settings trae set <key=value...>`       | 修改 Trae 设置（如 `rawChatPath=/api/...`）                          |
| `settings openrouter show`               | 显示 OpenRouter 提供商设置                                           |
| `settings openrouter set <key=value...>` | 修改 OpenRouter 设置（如 `baseUrl=https://openrouter.ai/api/v1`）    |
| `settings nvidia show`                   | 显示 NVIDIA NIM 提供商设置                                           |
| `settings nvidia set <key=value...>`     | 修改 NVIDIA 设置（如 `baseUrl=https://integrate.api.nvidia.com/v1`） |
| `settings auto-start show`               | 查看自启动状态                                                       |
| `settings auto-start on`                 | 开启自启动                                                           |
| `settings auto-start off`                | 关闭自启动                                                           |

### config — 配置查看

| 命令                  | 说明                                 |
| --------------------- | ------------------------------------ |
| `config path`         | 显示所有配置文件路径                 |
| `config show [--raw]` | 显示当前配置内容（默认脱敏 API Key） |

### logs — 日志管理

| 命令                                                                               | 说明                  |
| ---------------------------------------------------------------------------------- | --------------------- |
| `logs list [--category <cat>] [--request-id <id>] [--level <level>] [--limit <n>]` | 查询日志              |
| `logs export <json\|ndjson>`                                                       | 导出全部日志到 stdout |
| `logs clear`                                                                       | 清空日志              |

### shell — CLI 安装

| 命令                   | 说明                                           |
| ---------------------- | ---------------------------------------------- |
| `shell install-shim`   | 创建 `~/.local/bin/gatewayhub` 软链，加入 PATH |
| `shell uninstall-shim` | 移除软链                                       |

## 退出码

| 码  | 含义                               |
| --- | ---------------------------------- |
| 0   | 成功                               |
| 1   | 业务错误（账号不存在、配置无效等） |
| 2   | 命令行参数错误                     |
| 3   | daemon 不可达                      |
| 4   | 文件锁超时（并发写冲突）           |
| 5   | 用户取消（SIGINT）                 |

## 使用示例

```bash
# 启动后台网关
gatewayhub gateway start --port 8000

# 查看状态
gatewayhub gateway status

# 列出账号
gatewayhub account list

# 导入 refresh token
gatewayhub account-import token "Atza|IwEBIL..."

# 从文件批量导入
gatewayhub account-import json accounts.json

# 导入 Trae 国际服 refresh token 并测试账号
gatewayhub trae import-token "$TRAE_REFRESH_TOKEN"
gatewayhub trae list
gatewayhub trae test trae-refresh-xxxx

# 通过 Trae provider 做一次非流式聊天冒烟测试
gatewayhub trae chat "只回复 OK" --model deepseek-v3.2

# 导入 OpenRouter key 并用免费路由做一次冒烟测试
gatewayhub openrouter import-key "$OPENROUTER_API_KEY"
gatewayhub openrouter list
gatewayhub openrouter chat "只回复 OK" --model openrouter/free

# 导入 NVIDIA NIM API key 并做一次 OpenAI 兼容 chat 冒烟测试
gatewayhub nvidia import-key "$NVIDIA_API_KEY"
gatewayhub nvidia list
gatewayhub nvidia chat "只回复 OK" --model meta/llama-3.1-8b-instruct

# 创建 API Key
gatewayhub apikey create --name "production"

# 设置模型映射
gatewayhub mapping set gpt-4 --provider kiro --model claude-sonnet-4-6

# 查看日志
gatewayhub logs list --limit 20

# JSON 输出（适合脚本）
gatewayhub gateway status --json | jq '.data.providers[].models | length'

# 停止网关
gatewayhub gateway stop
```
