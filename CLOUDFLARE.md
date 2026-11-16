# Cloudflare 部署

应用由一个 Cloudflare Worker 提供静态前端和 `/api/*`；会话、偏好、文件映射与引用放在 D1，文件内容放在私有 R2 bucket。Worker 验证 Cloudflare Access 的 JWT 后，以其 `sub` 作为账户 ID。浏览器本地的旧 IndexedDB 会在首次登录后自动迁移到该账户。

## 创建资源

安装 Wrangler（本仓库通过 `pnpm dlx wrangler` 调用），登录 Cloudflare，然后创建 D1 和 R2：

```sh
if [ ! -f wrangler.toml ]; then cp wrangler.toml.example wrangler.toml; fi
pnpm dlx wrangler login
pnpm dlx wrangler d1 create ds-chat
pnpm dlx wrangler r2 bucket create ds-chat-files
```

若仓库目录中已有自己的 `wrangler.toml`，保留该文件。新建配置时从 [wrangler.toml.example](wrangler.toml.example) 复制。把 D1 命令返回的 `database_id` 替换配置中的本地占位 UUID。创建一个 Cloudflare Zero Trust Access 的 Self-hosted 应用，绑定最终访问域名，并设置只允许的用户或身份提供方策略。将应用的 AUD Tag 和团队域名填入 `ACCESS_AUD`、`ACCESS_TEAM_DOMAIN`。团队域名形如 `team-name.cloudflareaccess.com`，AUD Tag 可在 Access 应用的 Additional settings 中复制。

应用域名必须经过 Cloudflare 代理并受该 Access 应用保护，应用范围需要覆盖前端和 `/api/*`。Worker 优先验证 `Cf-Access-Jwt-Assertion`，浏览器请求缺少该头时也会验证同域的 `CF_Authorization` 应用 Cookie；两种方式都会检查签名、issuer、audience 和有效期。Cloudflare 文档说明浏览器请求会带应用 Cookie，但该 Cookie 不保证始终传到源站，因此仍建议让 Access 应用保护 `/api/*` 并优先使用 assertion header。[JWT 验证说明](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)。

若前端加载成功但 API 返回 `cloudflare_access_required`，在浏览器开发者工具的 Network 面板检查 `/api/...` 请求：确认请求发往受保护的同一域名，并确认请求 Cookie 中有 `CF_Authorization`（不要复制或分享 Cookie 值）。同时检查 Access 应用的域名和路径范围是否包含 `/api/*`；仅保护其他域名或路径不会给 API 请求提供该应用的身份凭据。401 响应中的 `reason` 可帮助排查：`worker_auth_not_configured` 表示生产 Worker 缺少 `ACCESS_TEAM_DOMAIN` 或 `ACCESS_AUD`；`audience_mismatch` 表示 `ACCESS_AUD` 与该 Access 应用的 AUD Tag 不一致；`issuer_mismatch` 或 `signing_key_not_found` 表示检查 `ACCESS_TEAM_DOMAIN`；`token_expired_or_not_yet_valid` 表示刷新 Access 登录；`missing_token` 表示请求未带 assertion header 或应用 Cookie。

先设置 API Key 加密密钥：

```sh
pnpm dlx wrangler secret put SETTINGS_ENCRYPTION_KEY
```

密钥使用 32 字节随机值的 Base64 编码。可用 Node.js 生成：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

请妥善保管该密钥；更换后，D1 中已加密的 API Key 将无法解密。不要把生产密钥写入 `wrangler.toml` 或提交到仓库。

`pnpm deploy` 会先构建，再应用所有尚未执行的 D1 migration，最后部署 Worker。若使用 Cloudflare Dashboard 或其他发布流程，必须先运行 `pnpm dlx wrangler d1 migrations apply ds-chat --remote`，再发布 Worker。

## 构建与发布

```sh
pnpm deploy
```

`wrangler.toml` 将 `dist` 配置为 Worker static assets，并让 `/api/*` 先经过 Worker。静态前端和 API 使用同一个域名，因此浏览器请求会携带 Access 会话。

## 本地开发

```sh
cp .dev.vars.example .dev.vars
pnpm dlx wrangler d1 migrations apply ds-chat --local
pnpm worker:dev
```

另开终端运行 `pnpm dev`。Rspack 将 `/api/*` 代理到本地 Worker。`.dev.vars` 仅用于本地模拟身份 `local-dev`，不要把开发配置部署到生产环境。Worker 本地使用 Wrangler 的 D1/R2 模拟绑定。

## 数据与索引

- API Key 单独用 AES-GCM 加密后存 D1；密钥只存在 Worker secret。其他偏好、会话和文件别名均按 Access `sub` 隔离。
- R2 对象键为 `sha256/<内容哈希>`，同一内容跨会话、跨账户只存一份。D1 文件别名和会话引用仍按账户隔离，R2 bucket 不公开。
- 删除会话时先移除该会话的文件引用；只有在所有会话和导入暂存都不再引用哈希后才删除 R2 对象。
- 会话同步维护 DeepSeek Files API 的 `file_id` 引用索引；删除会话或替换历史后，只删除已无任何会话引用的 DeepSeek 文件。升级时由 D1 migration 回填已有会话的文件引用。
- 会话列表每页读取 40 条，并使用覆盖索引 `(user_id, updated_at DESC, id DESC, title, created_at)`；滚动使用键集游标，不读会话 JSON。文件、导入、会话引用和对象清理使用对应的主键或覆盖索引；读取完整会话 JSON 仅发生在打开会话或导入替换时。
- 历史替换先写入 D1 暂存表，最后通过一个 D1 batch 原子替换会话和引用。中断的导入暂存会在 24 小时后开始下一次导入时清理。
