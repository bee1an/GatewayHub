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

| 命令                               | 说明                                          |
| ---------------------------------- | --------------------------------------------- |
| `settings kiro show`               | 显示 Kiro 提供商设置                          |
| `settings kiro set <key=value...>` | 修改 Kiro 设置（如 `vpnProxyUrl=http://...`） |
| `settings auto-start show`         | 查看自启动状态                                |
| `settings auto-start on`           | 开启自启动                                    |
| `settings auto-start off`          | 关闭自启动                                    |

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
