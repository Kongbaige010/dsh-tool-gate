# 安装

三种来源任选一种，**装完必须重启 DSH 桌面端**——插件由 Host 侧与 Client 侧两部分组成，徽章要等页面重新加载后才出现。

## 方式一：从 npm 装

```text
plugin_manager(install_bundle, target="@kongbaige010/dsh-tool-gate")
```

或界面操作：**插件** → **添加插件** → 填 `@kongbaige010/dsh-tool-gate`。

## 方式二：从 GitHub 装

```text
plugin_manager(install_bundle, target="github:Kongbaige010/dsh-tool-gate")
```

或界面操作：**插件** → **添加插件** → 粘贴 `https://github.com/Kongbaige010/dsh-tool-gate`。

> 若本机网络需要代理才能访问 GitHub，`install_bundle` 的直连探测会超时（它只走直连、5 秒硬超时）。改走方式三，用 `git clone` 显式带代理克隆到本地，再按本地目录安装。

## 方式三：本地目录（开发 / 离线机器）

```bash
git clone https://github.com/Kongbaige010/dsh-tool-gate \
    "C:/Users/<你>/.dsh/local-plugins/dsh-tool-gate"
```

```text
plugin_manager(install_bundle, target="<克隆下来的目录绝对路径>")
```

或 **插件** → **添加插件** → 选择该目录。

安装后 `profile` 的 `package.json` 会写入一条 `link:` 依赖，`dsh.profile.bundles` 末尾追加包名。

---

## 装完怎么确认生效

三步都可证伪，从上往下查：

| # | 看什么 | 期望 |
|---|---|---|
| 1 | 插件列表里的条目 | 出现「工具门控（MCP + 低频工具）」，不是灰块 |
| 2 | 任意助手回复的操作行末尾 | 出现只读徽章（形如 `MCP 门控 0/2`） |
| 3 | 让 Agent 调用 `mcp_services` | 返回受管服务列表与「受管 / 放行 / 隐藏」计数 |

第 2 步没出现但第 1 步正常时，刷新页面（`Ctrl+Shift+R`）；仍不出现再重启桌面端。

## 日常使用

| 工具 | 作用 |
|---|---|
| `mcp_services` | 列出受管服务、工具数与开/关状态 |
| `mcp_enable(services)` | 开启一个或多个服务（可用 `all`） |
| `mcp_disable(services)` | 关闭 |
| `tool_gate(action, group)` | 低频工具组（Mnemon 管理、定时提醒） |

**开启是下一步生效**：当前 step 的工具表已经发出去了，新开的服务要到下一个 step 才可见、可调用——仍属同一次对话回合。

## 卸载

走 `plugin_manager` 卸载，**不要手删 `node_modules`**：`link:` 方式手删不保证干净，还会在 `dsh.profile.bundles` 里留下悬空条目。
