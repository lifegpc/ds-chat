# chat-demo

[English](README.md) | 简体中文

基于 DeepSeek API 的聊天应用。会话、设置和附件存储在 Cloudflare Workers、D1 与 R2，登录使用 Cloudflare Zero Trust Access。浏览器直接请求 DeepSeek API。

部署前需要创建 Cloudflare D1、R2 和 Access 应用。详细步骤见 [Cloudflare 部署说明](CLOUDFLARE.md)。

## 运行

准备 Node.js 22.12+、pnpm 和 Cloudflare 资源。启动本地前端和 Worker：

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm build
cp .dev.vars.example .dev.vars
pnpm dlx wrangler d1 migrations apply ds-chat --local
pnpm worker:dev
```

另开终端运行：

```sh
pnpm dev
```

打开 http://localhost:8090 。

构建并发布 Cloudflare Worker：

```sh
pnpm deploy
```

Worker 会托管 `dist/` 前端并处理 `/api/*`。

## 功能

- 多会话、自动标题、重命名与删除；编辑提问、重新生成和切换消息分支。
- 流式回答、深度思考、智能搜索、链接阅读与来源引用；支持停止和符合条件的继续生成。
- 附件上传、粘贴与拖拽，语音输入和回复朗读；移动端录音时输入框首行显示实时频谱。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。

## 数据

设置和会话按 Cloudflare Access 身份隔离后保存在 D1，API Key 在 Worker 端加密存储。侧栏按页加载会话摘要，滚动时继续请求；会话详情在打开时读取。附件以 SHA-256 哈希作为 R2 对象键，同内容文件去重；最后一个会话引用删除后才清理文件。首次登录会将浏览器原 IndexedDB 中的会话与附件迁移到当前身份。发送对话、上传附件和使用语音功能时，相应内容会提交给配置的 API 服务。

设置中的历史导入导出使用 ZIP 格式。导入会在确认并校验成功后替换当前身份的全部云端会话和附件；导出包含会话与可用的图片原件，不包含 API Key、设置或非图片附件原件。格式与保留范围见[历史导入导出](src/services/chat/history/README.md)。

设置 → 数据管理 → 删除所有对话，会在确认后清空当前身份的云端会话和不再被引用的 R2 文件，以及未发送的草稿；正在生成的回复会停止。API Key 和其他设置保留，已上传到 DeepSeek API 的文件不受影响。

## 开发

| 命令          | 用途                |
| ------------- | ------------------- |
| `pnpm dev`    | 启动前端开发服务器  |
| `pnpm worker:dev` | 启动本地 Worker 和 D1/R2 模拟绑定 |
| `pnpm build`  | 构建到 `dist/`      |
| `pnpm deploy` | 构建并发布 Worker  |
| `pnpm type`   | TypeScript 类型检查 |
| `pnpm lint`   | oxlint 检查         |
| `pnpm format` | oxfmt 格式化        |

[rspack.config.ts](rspack.config.ts) 默认连接 `https://api.deepseek.com`。`createConfig({ apiOrigin, devServer })` 支持自定义 API 地址和开发服务器代理。

聊天默认使用 `deepseek-flash`，通过 Anthropic 兼容的 Messages / Files API 通信；语音使用 ASR / TTS 接口。请求使用搜索、链接阅读、标题和 `latest_reminder` 等扩展，接入服务需支持相应能力。附件实际支持的格式以服务端校验为准。

```text
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               API 请求、SSE 与协议类型
    chat/              会话、消息分支、云端存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    speech/            录音与朗读
  utils/               通用工具
worker/                Cloudflare Worker API
migrations/            D1 schema 与索引
```

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
