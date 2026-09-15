# 阅后即焚秘密消息服务 · spec.md

> 状态：设计规格草案
> 目标：从 0 开发一个基于 Cloudflare Workers 的极简加密消息分享服务。

## 1. 产品定位

提供一个无需账号的秘密消息分享服务：

- 创建消息
- 可选备注
- 可选密码
- 默认阅后即焚
- 可设置最大查看次数
- 可设置过期时间
- 支持 Markdown
- 支持图片
- 支持编辑区直接粘贴、拖拽、选择图片
- 浏览器端加密/解密
- 服务端永远看不到明文
- 服务端只保存密文和必要的生命周期元数据

不需要 VPS、MySQL、Redis 等外部基础设施。

---

## 2. 技术栈

- 前端：TypeScript + HTML/CSS
- 加密：Web Crypto API
- 后端：Cloudflare Workers
- 状态与存储：Durable Objects + SQLite（文本）、R2（图片密文）
- 定时过期：Durable Objects Alarm
- 部署：Cloudflare Workers

不使用：

- KV
- D1
- Redis
- MySQL

存储划分：

```text
文本 payload（备注 + Markdown + 附件清单） → Durable Object SQLite
图片密文（每张一个独立对象）              → R2，键 msg/<id>/<aid>
```

R2 桶保持**私有**：不配置公开访问域名，也不签发 presigned URL。全部对象读写
都要先过 DO 的令牌校验，再由 Worker 流式转发。否则密文可被无限次重复下载，
「阅后即焚」就只剩个说法。详见 §24。

图片功能可以整体关闭（见 §25）—— 部署配置里不声明 `r2_buckets` 即可，这样就不涉及
R2，也不需要在 Cloudflare 账号里绑定支付方式。这是给「只想部署一个纯文字版本」的人
留的路径。

---

## 3. 创建页面

创建页面包含：

```text
备注        [可选]

密码        [可选]

阅后即焚    ☑
            勾选：查看一次后立即删除
            未勾选：可查看次数 [5]

过期时间    [1小时 ▼]
            最大 7 天

消息内容
┌────────────────────────────┐
│ Markdown 编辑区             │
│                             │
│ 支持文字、图片、Markdown     │
│                             │
└────────────────────────────┘

[编辑] [预览]

                    [创建消息]
```

默认值：

- 阅后即焚：开启
- 过期时间：1 小时
- 密码：无
- 备注：无

关闭阅后即焚后，显示“可查看次数”选项。

查看次数建议范围：

- 最小：1
- 最大：100
- 默认：5

---

## 4. Markdown 编辑器

消息内容支持 Markdown。

图片不是独立上传功能，而是编辑器的一部分。

支持：

- 点击上传图片
- 拖拽图片到编辑区
- Cmd/Ctrl + V 粘贴图片
- 多张图片
- Markdown 图片语法
- 编辑/预览切换

例如：

```markdown
# 秘密消息

这是一些内容。

![图片](attachment://img-1)

这是图片后面的内容。
```

`attachment://img-1` 只是客户端内部引用，不是公网 URL。

---

## 5. 图片处理

图片（以及备注、正文）在创建消息之前始终停留在浏览器侧。

创建流程：

```text
本地图片
    ↓
File / ArrayBuffer（保持原始字节，不做 base64）
    ↓
浏览器内存
    ↓
K_att = HKDF(K_msg, "1tmsg/v1/attachment/<aid>")
    ↓
AES-256-GCM 加密（每张独立 IV）
    ↓
PUT /api/messages/:id/att/:aid → Worker → R2 对象 msg/<id>/<aid>
```

图片字节**不进 payload**：payload 里只留清单，记 `id / name / type / size / iv`。
所以文本密文大小与图片体积彻底解耦，图片上限不再受「整条消息 ≤ 10MB」约束。

图片不上传到第三方图床，也不产生公网图片 URL。

编辑/预览时：

```text
本地图片
    ↓
Blob
    ↓
Object URL
    ↓
<img>
```

查看消息时：

```text
GET /api/messages/:id/att/:aid（Bearer 一次性 readToken）
    ↓
Worker 从 R2 流式读出密文
    ↓
AES-GCM 解密（K_att 由 K_msg 现场派生）
    ↓
恢复图片 Blob
    ↓
Object URL
    ↓
<img>
```

限制：

- 单张图片 ≤ 10 MB
- 所有图片合计 ≤ 50 MB
- 文本 payload ≤ 10 MB（只作用于备注 + Markdown）

任何一张图片取回或解密失败都**不影响正文**，也不影响其余图片：
失败的会降级成「图片缺失」占位。

---

## 6. 消息 Payload

备注、Markdown、附件清单统一组成一个 Payload。

`version = 2`（当前）：

```json
{
  "version": 2,
  "note": "给朋友的备注",
  "content": "# 秘密消息\n\n这是内容。\n\n![图片](attachment://img-1)",
  "attachments": [
    {
      "id": "img-1",
      "name": "image.png",
      "type": "image/png",
      "size": 184320,
      "iv": "..."
    }
  ]
}
```

附件项里**没有图片字节，也没有密钥**：

- 图片密文是 R2 上的独立对象；
- 解密密钥 `K_att` 由 `K_msg` 确定性派生（§7），不需要存储；
- 只有 IV 必须随明文一起走，所以留在清单里。

整条 Payload 一次性进行 AES-256-GCM 加密，结果存入 DO 的 `chunk` 表。

`version = 1`（改造前的历史消息）附件项带 `data`（base64url 原始字节），
图片字节内嵌在密文里。查看端按 `version` / 字段分支，两种都能打开。

服务器无法区分其中哪些是：

- 备注
- Markdown
- 附件的名字与类型
- 其他内容

它只看到一个 base64url 字符串。

---

## 7. 密钥设计

每条消息生成：

```text
K_link = 32 bytes CSPRNG
```

其中：

- `K_link`：链接解密因子，保存于 URL Fragment
- `K_msg` 由 `K_link` 派生，不是独立随机数

分享链接：

```text
https://example.com/m/{messageId}#{fragment}
```

第一版推荐直接让 Fragment 保存 `K_link`。

如果消息设置了密码：

```text
password
    ↓
PBKDF2-HMAC-SHA256
    ↓
K_password
```

最终：

```text
K_link + K_password
        ↓
       HKDF
        ↓
      K_msg
```

因此带密码消息必须同时拥有：

```text
完整链接 + 密码
```

才能得到 `K_msg`。

没有密码时：

```text
K_link → K_msg
```

即可查看。

### 图片密钥：K_att

文本与图片用**两套密钥**：

```text
K_att(i) = HKDF-SHA256(
             ikm  = K_msg,
             info = "1tmsg/v1/attachment/" + aid
           )
```

- `K_msg`：加密文本 payload（备注 + Markdown + 附件清单）
- `K_att(i)`：加密第 i 张图片，**每张一个独立密钥**

HKDF 的 `info` 做了域分隔，因此：

- `K_att` 推不出 `K_msg`；
- 某一张图片的密钥推不出另一张；
- 拿到 R2 的全部对象也推不出任何密钥。

确定性派生意味着**图片密钥不需要任何额外存储**：只要持有完整链接
（+ 密码），任何一张图片的密钥都能现场算出来。

### 密码校验器：verifier

```text
verifier = HMAC-SHA256(K_password, "1tmsg/v1/pw-verify")
```

只用于「先验密码、再决定是否消耗查看次数」。它是单向 HMAC 输出，
且与 `K_att` 是两条独立派生链 —— 服务端拿到它无法解密，也推不出任何密钥。

### 重要原则

密码绝不：

- 出现在 URL
- 发送给服务器
- 保存到服务器
- 保存到 localStorage
- 写入日志

---

## 8. URL Fragment

链接格式：

```text
https://example.com/m/{messageId}#v1.{K_link}
```

`#` 后面的内容不会通过 HTTP 请求发送给服务器。

打开消息页面后：

1. 浏览器读取 `location.hash`
2. 获取 `K_link`
3. 解析 Fragment
4. 立即使用 `history.replaceState()` 清除 Fragment
5. 不保存到 localStorage/sessionStorage
6. 不发送给第三方脚本或统计服务

服务器只能看到：

```text
/m/{messageId}
```

看不到 `K_link`。

---

## 9. 服务端存储

每条消息对应一个 Durable Object。DO 内有**三张表**：

```sql
-- 元数据 + 状态机 + 令牌
message(
  id, version, status, iv, salt, kdf_iterations, verifier,
  created_at, expires_at, max_views, views, failed_attempts,
  upload_token, read_token, read_token_expires, purge_pending
)

-- 文本密文分片（DO SQLite 单值上限约 4 MiB，故按 1 MiB 切片）
chunk(idx, data)

-- 附件槽位与上传进度；图片密文在 R2，不在这里
attachment(aid, expected_bytes, bytes, uploaded)
```

`status` 三态：

```text
pending     有附件时创建后的初始态，等全部附件上传 + finalize
active      可消费
destroyed   tombstone；purge_pending=1 时 Alarm 持续重试清理 R2 对象
```

**R2 里只有图片密文**，键 `msg/<id>/<aid>`。服务端用一次前缀 list + 批量
delete 就能按消息清干净。

服务器绝不保存：

```text
明文
K_msg
K_att
K_link
password
K_password
ENCRYPTION_KEY
```

服务器保存的派生量只有 `verifier = HMAC(K_password, "…/pw-verify")`
以及 `salt` / `kdfIterations` 这两个**必须公开**的 KDF 参数 ——
没有它们客户端无法在解密前算出 `K_password`。

---

## 10. 创建流程

浏览器：

1. 收集备注、Markdown、图片
2. 将图片转换成 Payload attachments
3. 生成 `K_msg`
4. 生成 `K_link`
5. 如果设置密码，则生成 `K_password`
6. 根据 `K_link + K_password` 派生 `K_msg`
7. AES-256-GCM 加密 Payload
8. 将 ciphertext、IV、salt 和生命周期参数发送给 Worker
9. Worker 创建 Durable Object 消息
10. 返回 message ID
11. 浏览器生成分享链接

发送给服务器的数据：

```json
{
  "ciphertext": "...",
  "iv": "...",
  "salt": "...",
  "expiresInSeconds": 3600,
  "maxViews": 1
}
```

服务器不会收到：

```text
备注
Markdown
图片
password
K_link
K_msg
```

---

## 11. 查看流程

访问：

```text
GET /m/:id
```

只返回消息页面，不消费消息。

浏览器：

1. 读取 URL Fragment
2. 获取 `K_link`
3. 清除 Fragment
4. 如果设置了密码，显示密码输入页面
5. 用户输入密码
6. 浏览器本地执行 PBKDF2
7. 组合 `K_link + K_password`
8. 派生 `K_msg`
9. 调用 `/api/messages/:id/consume`
10. Durable Object 原子检查并返回 ciphertext
11. 浏览器 AES-256-GCM 解密
12. 恢复 Markdown 和图片
13. 本地渲染内容

密码输入错误时，不应该消费消息。

---

## 12. 密码验证

服务器不负责验证密码。

正确密码的判断方式：

```text
输入 password
      ↓
PBKDF2
      ↓
K_password
      ↓
HKDF(K_link + K_password)
      ↓
K_msg
      ↓
AES-GCM 解密
      ↓
GCM authentication tag 验证
```

解密成功：

```text
密码正确
```

解密失败：

```text
密码错误
```

因此密码原文永远不需要发送给服务器。

### 连续验密失败的锁定

服务端按消息维度记一个 `failed_attempts` 计数：

```text
验密失败 → failed_attempts += 1
验密成功 → failed_attempts = 0（清零，下次从满额度重新开始）
```

计数是**连续**的，不是消息生命周期内的累计值。达到 `MAX_FAILED_UNLOCK`（默认 10）次后消息进入锁定态：

```text
锁定 = 不可查看、不可恢复
密文仍留在 DO 内，直到 expires_at 到期由 Alarm 销毁（不是立即删除）
```

锁定后即使给出正确密码也一律返回 `locked` —— 判定在验密之前，所以这条路不可逆。

尚未达到上限时，`bad_password`（401）的响应体额外带 `attemptsRemaining`，
客户端据此提示「还可以尝试 n 次，用完后将被锁定」。
用掉最后一次额度的那一次请求直接返回 `locked`（423），不再返回 `bad_password`。

### 密码与查看次数的关系

验密失败**不消耗查看次数** —— 服务端先过 verifier，通过了才走计数与销毁。

---

## 13. 查看次数

默认：

```text
阅后即焚 = 开启
maxViews = 1
```

第一次成功消费后：

```text
active → destroyed
```

如果关闭阅后即焚：

```text
maxViews = N
```

例如：

```text
maxViews = 5
```

每次成功消费：

```text
views += 1
```

达到：

```text
views >= maxViews
```

立即删除消息。

查看次数必须由 Durable Object 原子控制，防止并发请求突破限制。

---

## 14. 消费接口

```text
POST /api/messages/:id/consume
```

Durable Object 内部原子执行（同步临界区，全部落库后才可能 await）：

```text
检查消息是否存在
        ↓
status == destroyed ? → gone
        ↓
status == pending ?   → 409 not_ready（避免拿到缺图的半条消息）
        ↓
检查是否过期
        ↓
先验密码（错误绝不消耗查看次数）
        ↓
检查 views < maxViews
        ↓
views + 1
        ↓
签发一次性 readToken（TTL 5 分钟）
        ↓
如果达到 maxViews，则抹掉文本密文（进入 destroyed）
        ↓
返回 ciphertext + readToken
```

对于默认阅后即焚消息：

```text
maxViews = 1
```

第一次成功消费即销毁文本密文。

### 销毁后的下载宽限期

图片密文在 R2 上，不在 DO 里 —— 如果 consume 一销毁就把 R2 对象删掉，
**这一次访问反而拿不到图片**。所以销毁路径仍然签发 `readToken`，
并把 Alarm 定在令牌过期时刻才清 R2 对象：

```text
consume（maxViews 用完）
        ↓
文本密文立即从 DO 抹掉
        ↓
readToken 有效，附件仍可下载（宽限期 = READ_TOKEN_TTL_MS）
        ↓
Alarm 到点 → 删 R2 前缀 → 清 attachment 表 → 收掉 Alarm
```

清理失败会重新武装 Alarm 重试；即使 DO 被驱逐导致 Alarm 丢失，
R2 桶的生命周期规则仍会把孤儿对象清掉。

---

## 15. 过期

默认：

```text
1 小时
```

最大：

```text
7 天
```

建议提供：

```text
1小时
6小时
12小时
1天
3天
7天
```

创建消息后由 Durable Object 设置 Alarm。

过期：

```text
active → destroyed
```

并删除 SQLite 数据。

---

## 16. Markdown 渲染

Markdown 只在浏览器本地解析。

流程：

```text
Markdown
   ↓
Markdown Parser
   ↓
HTML
   ↓
DOMPurify
   ↓
DOM
```

禁止直接：

```text
marked.parse(markdown)
→ innerHTML
```

必须进行 XSS 清理。

图片引用：

```text
![图片](attachment://img-1)
```

解析时由客户端替换成对应的 Blob URL。

### 折行约束

正文里任何一行都可能很长（无空格长串、长链接、代码块、多列表格），
在移动端必须**折行显示**，绝不允许横向溢出后被卡片静默裁掉。

| 位置 | 规则 | 原因 |
| --- | --- | --- |
| `.md` 容器 | `overflow-wrap: anywhere` | `break-word` 不参与 min-content 计算，auto 布局的表格仍会被长串顶破 |
| `.md pre` | `white-space: pre-wrap` | `<pre>` 默认 `pre` 自身就拒绝折行，只加 `overflow-wrap` 无效 |
| `.md th` | `white-space: nowrap` | 2 字中文表头在 `anywhere` 下会被拆成两行 |
| `table` | 由 `hydrateMarkdown` 包一层 `.md-scroll` | 列多/表头超宽时退化为横向滑动，宁可滑动也不丢内容 |
| `.note` / `.notice` / `.rdone` 里的文本 | `min-width: 0` + `anywhere` | flex 文本项默认 `min-width: auto`，长串会顶开整行 |

回归测试：`test/styles.test.ts`（声明级）+ `test/browser/suite.ts`（真实 Chrome 布局测量，320px 容器）。

---

## 17. 安全模型

最终目标：

| 数据/权限 | 服务器是否拥有 |
|---|---|
| 明文 | ❌ |
| K_msg | ❌ |
| K_link | ❌ |
| password | ❌ |
| K_password | ❌ |
| ciphertext | ✅ |
| IV | ✅ |
| salt | ✅ |
| 过期时间 | ✅ |
| 查看次数 | ✅ |
| 消息 ID | ✅ |

数据库泄露时：

```text
ciphertext + metadata
```

无法直接恢复消息。

Cloudflare Worker / Durable Object 也无法解密消息。

---

## 18. 前端信任边界

客户端加密成立的前提是：

> 用户运行的前端 JavaScript 是可信的。

因此：

- 不依赖未经固定版本的第三方 JS CDN
- JS/CSS 尽量自托管
- 不使用第三方统计
- 不向第三方发送 URL Fragment
- 不记录密码
- 不记录解密密钥
- 不记录完整分享链接

建议 CSP：

```text
default-src 'none';
script-src 'self';
style-src 'self';
img-src 'self' data: blob:;
connect-src 'self';
base-uri 'none';
form-action 'self';
frame-ancestors 'none';
```

安全响应头：

```text
Cache-Control: no-store
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Cross-Origin-Opener-Policy: same-origin
```

---

## 19. API

```text
POST /api/messages
```

创建消息。请求体含文本密文、生命周期参数，以及**附件清单**（只报 `id` 与 `size`）。
返回 `{ id, expiresAt, maxViews, uploadToken }` —— 无附件时 `uploadToken` 为 `null`。

```text
PUT /api/messages/:id/att/:aid
```

写入单张图片密文（二进制直传，`Authorization: Bearer <uploadToken>`）。
Worker 先让 DO 校验令牌与槽位，再流式写进 R2。

```text
POST /api/messages/:id/finalize
```

全部附件就位后把消息从 `pending` 推进到 `active`；有缺件则 409。

```text
GET /api/messages/:id/att/:aid
```

读取单张图片密文（`Authorization: Bearer <readToken>`），Worker 从 R2 流式转发。
令牌无效或过期一律 403。

```text
GET /api/messages/:id
```

只读元数据，不消耗查看次数、不含密文与附件标识。

```text
POST /api/messages/:id/consume
```

原子消费并获取文本密文与一次性 `readToken`。

```text
DELETE /api/messages/:id
```

主动销毁消息（连同 R2 对象），可选。

```text
GET /m/:id
```

返回消息页面。

不需要复杂 REST API。

---

## 20. 项目结构

建议：

```text
src/
├── index.ts              # Worker 入口 / 路由
├── message-box.ts        # Durable Object
├── crypto.client.ts      # 浏览器端加密、密钥派生
├── message.client.ts     # 创建/查看消息逻辑
├── editor.ts             # Markdown 编辑器与图片处理
├── render.ts             # 页面渲染
├── types.ts              # 类型定义
├── config.ts             # 限制与默认配置
└── styles.css

test/
├── crypto.test.ts
├── message-box.test.ts
└── e2e.test.ts

wrangler.jsonc
package.json
README.md
```

---

## 21. 开发阶段

### P0：基础架构

- Workers
- Durable Objects
- SQLite
- 基础路由
- 创建/读取消息
- 过期 Alarm
- 查看次数

### P1：客户端加密

- AES-256-GCM
- CSPRNG
- K_link
- PBKDF2
- HKDF
- URL Fragment
- 密码保护

### P2：编辑器

- Markdown 编辑
- Markdown 预览
- 图片粘贴
- 图片拖拽
- 图片选择
- 图片本地预览
- 加密图片存储
- 解密后图片显示

### P3：安全加固

- CSP
- XSS 防护
- 安全响应头
- 第三方资源清理
- URL Fragment 清理
- 消息大小限制
- 图片大小限制
- Rate Limit
- 并发消费测试

---

## 22. 最终架构

```text
                    创建消息
                       │
                       ▼
        ┌──────────────────────────────┐
        │           浏览器             │
        │                              │
        │  明文消息 ─┐                 │
        │  本地图片 ─┴─→ K_msg         │
        │                  │           │
        │        ┌─────────┴─────────┐ │
        │        ▼                   ▼ │
        │   AES-GCM(K_msg)   AES-GCM(K_att(i))
        │        │                   │ │
        │   密文文本            密文图片 ×N
        └────────┼───────────────────┼─┘
                 │                   │
                 │              PUT /att/:aid
                 │              （Bearer uploadToken）
                 ▼                   ▼
        ┌──────────────────────────────────┐
        │      Cloudflare Worker           │
        │  鉴权 · 流式转发 · ASSETS 兜底    │
        └───────┬──────────────────┬───────┘
                │                  │
                ▼                  ▼
     ┌──────────────────┐   ┌──────────────┐
     │ Durable Object   │   │  R2 bucket   │
     │  MessageBox      │   │  1tmsg-blobs │
     │                  │   │              │
     │ message 元数据   │   │ msg/<id>/<aid>
     │ chunk   文本密文 │   │ 图片密文     │
     │ attachment 槽位  │   │ （私有桶）   │
     └──────────────────┘   └──────────────┘
        只保存密文             只保存密文


                    查看消息
                       │
                       ▼
                /m/{messageId}
                       │
                       ├── URL Fragment
                       │       ↓
                       │    K_link
                       │
                       ├── 密码（可选）
                       │       ↓
                       │   PBKDF2
                       │
                       ▼
                   HKDF
                       │
                       ▼
                    K_msg
                       │
                       ├──→ /consume ──→ 文本密文 ──→ 解密 ──→ Markdown 渲染
                       │      （返回一次性 readToken）
                       │
                       └──→ HKDF(info = "…/att/<aid>")
                                ↓
                             K_att(i)
                                ↓
                    GET /att/:aid（Bearer readToken）
                                ↓
                        R2 密文 ──→ 解密 ──→ 图片显示
```

## 23. 核心原则

整个项目只遵循三个核心原则：

### ① 内容只在浏览器明文存在

```text
明文 → 浏览器加密 → 密文 → CF
CF → 密文 → 浏览器解密 → 明文
```

### ② 服务端只负责存储和生命周期

Worker / DO 不负责：

- 解密
- 密码验证
- Markdown 解析
- 图片解析

只负责：

- 保存密文
- 过期
- 查看次数
- 原子消费
- 删除

### ③ 默认就是阅后即焚

创建消息后：

```text
阅后即焚 ☑
过期时间 1小时
```

用户无需理解复杂的安全机制，就可以直接创建一条：

> **打开一次，服务器保存的密文立即销毁，只有持有正确链接/密码的人才能在浏览器中看到内容。**

---

## 24. 图片密文外置到 R2

### 动机

改造前图片字节被 base64url 后内嵌进 payload，于是：

- 图片与文本共享同一个「消息 ≤ 10MB」上限，而该上限校验的是**已 base64 的明文**，
  体积膨胀 4/3 —— 10MB 原图会先撞上限，图片实际只能发约 7.5MB；
- 大图把 DO SQLite 的体积顶起来，而 DO 存储比 R2 贵；
- 想放开图片大小就必须抬高消息上限，同时放大 DO 存储与出口流量。

外置到 R2 后：文本密文恒定在几 KB，图片上限与消息上限彻底解耦。

### 安全论证：服务器看不到图片

```text
R2 里存的是  AES-256-GCM(K_att, 图片原始字节)
K_att 只能由 K_msg 派生
K_msg 只能由 K_link ‖ K_password? 派生
K_link 只存在于 URL Fragment —— 按 HTTP 规范 fragment 不参与请求，
       浏览器不会把它放进请求行，服务器日志 / CDN / Referer 都拿不到
```

**结论：R2 泄露 ≠ 图片泄露。** 把整个桶和 DO 整个数据库都端走，得到的是一堆
随机字节 —— 缺少的是密钥链的起点，而不是某一环。

服务端全程没有解密代码路径：Worker 对 R2 只做 `get()` 字节搬运。
`verifier` 也补不上缺口，它是单向 HMAC，且与 `K_att` 分属两条派生链。

### 与改造前的差异（必须知道的一项变弱）

| 维度 | 改造前（密文合一） | 改造后（R2） |
|---|---|---|
| 机密性 | 强 | **同样强**（密钥链未变） |
| 阅后即焚的严格性 | 删即消失 | **稍弱**：对象在删除前有存活窗口 |
| 原子性 | 一次 consume 拿到全部 | 需要 pending / finalize / acked 三段 |
| 单图上限 | ~7.5MB | 独立可配（当前默认 10MB） |
| DO 存储 | 密文全在 SQLite | 只留元数据，体积恒定 |

「稍弱」的具体表现与对策：

- 销毁后仍有 `READ_TOKEN_TTL_MS`（5 分钟）下载宽限 —— 这是**功能需要**，
  否则最后一次访问拿不到图片；
- 宽限期一过由 Alarm 清对象，失败会重试；
- 即使 Alarm 丢失，桶的**生命周期规则（7 天）**仍会清掉孤儿对象。

### 三条硬性约束

1. **桶必须私有。** 不配置公开访问域名，不签发 presigned URL。
   一旦公开，密文可被无限次重复下载，阅后即焚名存实亡。
2. **读写全走 Worker。** 上传/下载都要过 DO 的令牌校验：
   - 上传：`uploadToken`，仅 `pending` 阶段有效，与附件槽位绑定；
   - 下载：`readToken`，每次 consume 重新签发、旧的立即作废、5 分钟过期。
3. **对象键必须可前缀匹配**：统一 `msg/<id>/<aid>`，
   这样「按消息清理」就是一次 list + 批量 delete。

### 附带要求

**仅带图片的版本**（用了 `wrangler.images.jsonc`，见 §25）才需要在部署配置里
声明绑定，并预先建桶：

```bash
npx wrangler r2 bucket create 1tmsg-blobs
```

```jsonc
"r2_buckets": [{ "binding": "BLOBS", "bucket_name": "1tmsg-blobs" }]
```

桶的生命周期规则建议设为 **7 天**，与最长消息 TTL 一致 ——
它是所有清理失败路径的最后兜底，不是主要机制。

### 兼容性

`payload.version` 从 1 升到 2。查看端必须同时支持：

- `version = 1` 或附件项带 `data` → 历史消息，图片字节内嵌在密文里，直接 base64 解码；
- 附件项带 `iv` → 新消息，图片密文在 R2，用 `K_att` 解密。

两种路径都失败时只降级成「图片缺失」占位，正文照常显示。

---

## 25. 图片功能的整体开关

R2 开通时必须绑定支付方式，不是每个部署者都愿意。所以图片功能做成可整体关闭的 ——
但这件事**不能只在代码里判断**，必须在配置层落地。

### 为什么必须在配置层解决

只要 `wrangler.jsonc` 里声明了 `r2_buckets`，账号未开通 R2 时 `wrangler deploy` 会在
**部署阶段**直接报错退出 —— 不是运行时才失败。也就是说，一个根本不碰图片的部署，
只要配置里还留着绑定就上不去。所以「关闭图片」= 部署配置里**没有**这一段。

### 两份配置，一个判据

| 配置文件 | `r2_buckets` | 结果 |
|---|---|---|
| `wrangler.jsonc` | 注释掉 | 不带图片；整条链路不碰 R2，不需要开通 |
| `wrangler.images.jsonc` | 生效 | 带图片；需先开通 R2 并建桶 |

**「配置里有没有 `r2_buckets`」是唯一判据，三层都读它：**

| 层 | 关闭时的表现 | 由谁读 |
|---|---|---|
| 构建期 | `__ENABLE_IMAGES__ = false`，图片代码整块被消除 | `scripts/feature-flag.mjs` → `build-client.mjs` |
| Worker 运行时 | `env.BLOBS === undefined`；`/att/:aid` 返回 404；创建接口对非空 `attachments` 返回 400 `images_disabled` | `src/index.ts`、`src/message-box.ts` |
| 前端 | 图片入口不出现、拖拽与粘贴监听不注册 | `src/client/editor.ts` |

早期版本用过 `vars.ENABLE_IMAGES` 作为开关、由构建脚本按它增删 `r2_buckets`，现已去掉：
那等于让「变量」和「绑定是否声明」两处都可以表达同一件事，就可能不一致。而绑定本身
既决定运行时能力、又是构建期要读的东西，是天然的唯一事实来源。

> 代价：不再支持用环境变量临时切换版本。想换版本就换模板（或增删那一行绑定），
> 换来的是「配置里看到什么，跑起来就是什么」。

### 选哪份配置：一条 `-c` 管两条链路

默认读 `wrangler.jsonc`；想用别的文件（比如不进库的个人配置 `wrangler.me.jsonc`）：

```bash
npm run deploy -- -c wrangler.me.jsonc
npm run dev    -- -c wrangler.me.jsonc
```

这里有个坑值得写下来：**`npm run x -- <参数>` 的参数只会被 npm 追加到脚本命令末尾**。
原来的 `deploy` 是复合脚本 `npm run build && wrangler deploy`，参数只落在 wrangler 上，
链首的 build 收不到 —— 于是 build 读 `wrangler.jsonc`、deploy 读 `-c` 指定的文件，
出现「前端关掉图片入口、后端却带 `env.BLOBS`」的漂移，正是本节想消灭的那种漂移。

所以部署入口改成了一层脚本 `scripts/run.mjs`：它在链首接住 `-c`，写成环境变量
`WRANGLER_CONFIG` 喂给 `scripts/feature-flag.mjs`，再把同一个路径用 `-c` 传给 wrangler，
两条链路必然同源。日志首行会把结果打出来，漂移一眼可见：

```text
[run] 配置：wrangler.me.jsonc｜图片：启用｜默认语言：zh
```

硬约束：

- **配置文件后缀必须是 `.jsonc` / `.json` / `.toml`。** wrangler 靠后缀判定格式，
  后缀不认识时**静默忽略整份配置**（不报错，表现为交互式追问项目名、最后报
  `Missing entry-point`）。`scripts/run.mjs` 会提前拦掉这种情况。
- **`wrangler.jsonc` 必须留在 git 里。** Deploy to Cloudflare 按钮会读仓库中的
  wrangler 配置来 provision 资源（R2 桶 / DO 命名空间）并可能回写资源 ID；
  个人配置只能作为额外文件存在（且应进 `.gitignore`）。
- 不带 `-c` 时行为与 `npm run build && wrangler deploy` 完全一致 —— 一键部署会
  不带参数地取 `package.json` 里的 `deploy` 脚本执行。

### 前端为什么写成全局标识符

`__ENABLE_IMAGES__` 由 esbuild `define` 直接替换成字面量。写法上有三条硬约束，
都是为了让关闭时图片代码真的从产物里消失（以下每一条都实测踩过）：

1. **不要套一层 `const IMAGES_ENABLED = __ENABLE_IMAGES__`** —— 变量会被重命名成模块级
   符号，常量传不进条件里，`if (IMAGES_ENABLED)` 整块死代码都会留下。
2. **不要用 `if (!…) return` 提前返回** —— 能被压掉的是「常量条件下的整块语句」，
   `return` 之后的代码不在块里，削不掉。
3. **必须写成 `if (…) {…} else {…}`** —— `赋值; if(常量){…}` 会被 esbuild 的语句合并
   并成 `if(赋值, 常量){…}`，条件不再是纯常量，整块同样删不掉。

也正因为如此，开关不能放进一个共享模块：本项目两个入口 + `splitting`，任何被两个入口
共用的模块都会进共享 chunk，常量同样内联不进来。改用 `build-flags.d.ts` 声明全局标识符，
各文件直接引用。产物体积：关闭时 `create.js` ≈ 10.3 KB，开启时 ≈ 12.8 KB。

### 入口的隐藏方式

`public/index.html` 里图片入口（`#pickImg`、`#atray`、工具栏分隔符）**静态就带 `hidden`**，
由 `mount()` 在开关为真时移除。也就是说**默认态就是关闭态**：即使脚本没跑起来，
不带图片的版本也不会露出入口，不需要依赖 JS 去纠正。

编辑器里其余图片行为（拖拽高亮、粘贴、选图、托盘）全部收在同一个
`if (__ENABLE_IMAGES__) { … }` 块里。只藏按钮不摘监听是不行的 ——
那样用户拖进图片会被静默吞掉，「什么都没有发生」比「明确不支持」更难理解。

### 边界情况

- **先开后关**：之前发出的带图片消息，图片取不回来（`/att` 已 404）。`view.ts` 保留
  v1 内嵌图片的解密路径；v2 走「图片缺失」占位，正文与备注正常显示。
- **先关后开**：没有历史包袱，图片功能直接可用。
- **本地开发**：`wrangler dev` 用的是本地模拟存储，即使声明了 `r2_buckets`
  也**不需要**真的开通 R2，不涉及绑卡。

---

## 26. 界面语言与传输体积

### 26.1 双语与默认语言

中英两套文案，部署时用环境变量选默认语言：

```jsonc
// wrangler.jsonc
"vars": { "DEFAULT_LOCALE": "zh" }   // "zh" | "en"，缺省 zh
```

- **单一真源**：与图片开关同思路 —— 判据只有 `vars.DEFAULT_LOCALE` 一处。
  构建期由 `scripts/feature-flag.mjs` 读它并生成 `src/i18n/active.ts`（不入库），
  页面文案渲染（`scripts/build-html.mjs`）也读同一处，两边不会漂移。
- **键表以中文为准**：`src/i18n/zh.ts` 导出 `type MsgKey = keyof typeof zh`，
  `en.ts` 标注 `Record<MsgKey, string>` —— **少一条就编译不过**，这是不漏译的保证。
- **体积策略**（针对极差网络）：
  - 默认语言字典**静态**进主 chunk；另一种语言走 `import()`，esbuild splitting
    切成独立 chunk，只有用户点右上角切换按钮时才下载（不做浏览器语言自动跟随）。
    「哪份静态、哪份动态」由生成的 `active.ts` 直接决定，不依赖打包器消除死分支。
  - HTML 静态文案在**构建期**按默认语言烤进 `public/*.html`
    （`data-i18n` 标键，脚本只替换文本/属性值）。脚本没跑起来时页面也是
    完整可读的默认语言，没有占位键、没有闪烁。zh 部署下这个步骤是零改动（幂等）。
- **运行期约定**：
  - `data-i18n="key"` → 元素**纯文本**；`data-i18n-<attr>="key"` → 属性文案
    （placeholder / title / aria-label / content）。
  - 局部加粗/斜体一律拆成相邻的多个键 + 相邻元素，**不往 innerHTML 塞字典内容**，
    与 §16/§18 的信任边界一致。
  - 带参数的动态文案（剩余次数、取回进度）不能留在 data-i18n 里
    （切换语言时还原不了参数），由各页面在 `onLocaleChange` 回调里重算。
- **切换入口**：两页顶栏固定一个按钮，显示「点一下会切到的那种语言」
  （中文界面显示 EN，英文界面显示 中文）。用户手动切换的选择存
  `localStorage["1tmsg:locale"]` —— 只存 `"zh"`/`"en"` 两个字节，不含任何消息或密钥；
  不自动跟随浏览器语言 —— `DEFAULT_LOCALE` 是站点的语言而非首屏暂态，避免语言不匹配的访客经历「先默认后切换」的闪烁；只有用户主动点击才写存储。

### 26.2 服务端错误文案

- 服务端 `message` 统一为**英文**，作为 API 的中立兜底（直接调 API 的外部调用方看英文）。
- 前端按 `error code` 映射当前语言的文案（`src/client/api.ts` 的 `CODE_KEYS`），
  未知 code 才回落服务端原文。`rate_limited` 的秒数来自 `Retry-After` 响应头。

### 26.3 传输体积：`no-transform` 与压缩

实测发现 `Cache-Control: no-store, no-transform` 让 Cloudflare **完全不做压缩**
（文档原话：Compression is disabled when the `no-transform` directive is present，
zone 级 Compression Rules 也会被它绕过），首屏 137 KB 全部裸传。

但 `no-transform` 不能整体删 —— 它挡的是自定义域名上 CF 往 HTML 注入 RUM 探针
（`static.cloudflareinsights.com/beacon.min.js`），注入即破坏端到端加密承诺（§18）。
处理方式是把两类响应拆开：

| 响应 | `no-transform` | 原因 |
|---|---|---|
| HTML（`/`、`/m/:id`） | **保留** | 防注入是安全硬需求；HTML 只有 ~12 KB，压缩收益小 |
| `/assets/*`（CSS/JS） | **去掉** | CF 只往 HTML 注入东西；这里放开压缩零安全代价 |

`_headers` 里用 `! Cache-Control` detach 语法实现 —— 多规则命中是**逗号拼接**而不是
「更具体的覆盖更宽的」，少这一行会拼出 `no-store, no-transform, no-cache`，
`no-transform` 仍在，压缩照样被否决。`/m/:id` 由 Worker 生成响应，`_headers` 不作用于它，
安全头来自 `src/http.ts` 的 `secure()`，本来就带 `no-transform`。

体积账（gzip，实测/估算）：首屏 137 KB → **约 50 KB**（−63%）；
其中 i18n 的代价约 +5 KB（默认语言字典进主 chunk），切换语言再 +3.6 KB（按需 chunk）。
