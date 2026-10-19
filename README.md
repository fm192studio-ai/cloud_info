# Cloudflare Workers + D1 Serverless 跨境电商地址采集中心

基于 **Cloudflare Workers** (全球边缘计算) 与 **Cloudflare D1** (Serverless 边缘分布式 SQLite 数据库) 构建的云端地址接收与数据归档系统。

像您之前构建的 **Serverless qrcode hub** 一样，该方案：
- 🌟 **零服务器运维成本**：无需购买和维护云服务器/VPS，享受 Cloudflare 每日海量免费额度。
- ⚡ **全球低延迟**：无论您或采集脚本部署在何处，均通过 Cloudflare 全球边缘就近接入。
- 🛡️ **唯一指纹毫秒级去重**：依托 D1 数据库底层 `UNIQUE(fingerprint)`，多台 Windows/Mac 客户端并发上报时零竞态、自动去重。
- 🔒 **环境变量安全保护**：支持配置 `ADMIN_PASSWORD` 密钥变量，保护 Web 大屏和接收端接口。
- 📊 **开箱即用可视化大屏**：内置现代化响应式管理看板、搜索过滤、单条详情、UTF-8 BOM 兼容 CSV/JSON 导出。

---

## 目录文件结构

```text
remote_collector/cloudflare_worker/
├── package.json          # 项目依赖与便捷 npm 脚本
├── wrangler.toml         # Cloudflare Workers & D1 绑定配置
├── schema.sql            # D1 数据库建表与防重索引 DDL
├── README.md             # 部署与配置图文指南
└── src/
    └── index.js          # Workers 边缘服务入口 (路由、API、去重、WebUI)
```

---

## 极速部署指南（5 分钟完成）

请确保您的电脑已安装 Node.js（推荐 Node 18+）。

### 第一步：进入 Worker 目录并登录 Cloudflare

打开终端（Terminal），切换到该目录：

```bash
cd /Volumes/Data/CODE/web/record/remote_collector/cloudflare_worker
```

如果尚未在终端登录 Cloudflare，运行以下命令完成浏览器授权登录：

```bash
npx wrangler login
```

---

### 第二步：创建 Cloudflare D1 数据库

运行以下命令创建名为 `address_db` 的数据库：

```bash
npx wrangler d1 create address_db
```

命令执行成功后，终端会打印如下输出信息：

```toml
[[d1_databases]]
binding = "DB"
database_name = "address_db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  <-- 复制此 ID
```

打开该目录下的 `wrangler.toml` 文件，将刚刚生成的 `database_id` 填入：

```toml
[[d1_databases]]
binding = "DB"
database_name = "address_db"
database_id = "替换为您终端输出的真实-database_id"
```

---

### 第三步：初始化 D1 数据库数据表

使用提供的 `schema.sql` 在云端 D1 数据库中建表：

```bash
npx wrangler d1 execute address_db --remote --file=./schema.sql
```

终端提示 `✔ Executed ... commands successfully` 即代表建表及去重索引建立完成。

---

### 第四步：设置变量密码 (ADMIN_PASSWORD)

为防止未经授权的人员查看您的数据或向接口灌入垃圾数据，建议通过 Cloudflare Secret 加密设置访问密码：

```bash
npx wrangler secret put ADMIN_PASSWORD
```

按回车后输入您想要设置的强密码（如 `MySecurePass2026!`）。

*(注：如果想在本地测试或直接在 wrangler.toml 中填写明文，也可直接编辑 `wrangler.toml` 中的 `ADMIN_PASSWORD = "..."`)*

---

### 第五步：部署到 Cloudflare Workers

运行部署命令：

```bash
npx wrangler deploy
```

部署完成后，终端会输出您专属的公网访问 URL，形如：

```text
Published remote-address-collector (x.xx sec)
  https://remote-address-collector.<你的账户子域>.workers.dev
```

在浏览器打开该网址即可进入您的 Web 归档大屏！

---

## 客户端与油猴脚本对接配置

部署成功后，将您的 Worker 地址配置到客户端。

### 1. 本地客户端配置 (`remote_collector/client/config.json`)

打开 `remote_collector/client/config.json`，修改为您的 Worker 地址及密码：

```json
{
  "server_url": "https://remote-address-collector.<你的账户子域>.workers.dev/api/receive",
  "auth_token": "您设置的 ADMIN_PASSWORD 密码",
  "poll_interval_seconds": 1.5,
  "enable_chrome_cdp_monitor": true,
  "chrome_cdp_port": 9222,
  "enable_clipboard_monitor": true
}
```

### 2. 油猴脚本配置 (`tampermonkey.user.js`)

若使用油猴脚本直接推送到外网：

```javascript
// ==UserScript==
// ...
const SERVER_URL = "https://remote-address-collector.<你的账户子域>.workers.dev/api/receive";
const AUTH_TOKEN = "您设置的 ADMIN_PASSWORD 密码";
```

### 3. 测试连通性

运行连通性测试脚本验证远程推送是否畅通：

```bash
cd /Volumes/Data/CODE/web/record/remote_collector/client
python3 test_send.py
```

终端若返回 `✅ [测试成功] 服务器返回响应: saved_count: 1`，并在 Web 网页端立刻能看到测试数据，即代表全链路打通！

---

## 常用开发与运维命令

在 `remote_collector/cloudflare_worker/` 目录下：

| 命令 | 说明 |
| :--- | :--- |
| `npm run deploy` 或 `npx wrangler deploy` | 部署最新代码到 Cloudflare 全球边缘节点 |
| `npm run dev` 或 `npx wrangler dev` | 启动本地模拟 Workers 调试 |
| `npm run tail` 或 `npx wrangler tail` | 实时查看边缘 Workers 的运行与报错日志 |
| `npm run secret:set` | 更新或更换管理员访问密码 |
| `npx wrangler d1 execute address_db --remote --command="SELECT COUNT(*) FROM records"` | 终端直接查询 D1 数据量 |

---

## 接口说明列表

| 路径 | 方法 | 鉴权方式 | 说明 |
| :--- | :--- | :--- | :--- |
| `/` | `GET` | 浏览器弹窗输入密码 | 响应式数据汇总大屏与管理后台 |
| `/api/ping` | `GET` | 无需鉴权 | 健康检测与心跳接口 |
| `/api/receive` | `POST` | `Bearer <TOKEN>` / `x-auth-token` | 核心地址接收与 D1 去重写入接口 |
| `/api/records` | `GET` | `Bearer <TOKEN>` 或 `?token=...` | 获取地址列表 (支持 `?q=关键词&limit=200`) |
| `/api/export/csv` | `GET` | `Bearer <TOKEN>` 或 `?token=...` | 导出 UTF-8 BOM 编码的 Excel 友好 CSV 文件 |
| `/api/export/json` | `GET` | `Bearer <TOKEN>` 或 `?token=...` | 导出完整 JSON 数据备份 |
| `/api/delete` | `POST` | `Bearer <TOKEN>` | 删除单条记录 `{ id: "..." }` |
| `/api/clear` | `POST` | `Bearer <TOKEN>` | 清空所有记录 `{ confirm: "CONFIRM_DELETE_ALL" }` |
