# chat-demo

English | [简体中文](README.zh-CN.md)

A chat app powered by the DeepSeek API. Conversations, settings, and attachments use Cloudflare Workers, D1, and R2. Sign-in uses Cloudflare Zero Trust Access, and the browser connects directly to DeepSeek for chat requests.

Create Cloudflare D1, R2, and Access resources before deployment. See the [Cloudflare deployment guide](CLOUDFLARE.md) for setup and local development.

## Getting started

Install Node.js 22.12+, pnpm, and set up the Cloudflare resources. Start the local Worker and frontend:

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm build
cp .dev.vars.example .dev.vars
pnpm dlx wrangler d1 migrations apply ds-chat --local
pnpm worker:dev
```

In another terminal, run:

```sh
pnpm dev
```

Open http://localhost:8090.

To build and deploy the Worker:

```sh
pnpm deploy
```

The Worker serves the `dist/` frontend and handles `/api/*` requests.

## Features

- Multiple conversations with automatic titles, renaming, and deletion; edit prompts, regenerate replies, and switch between message branches.
- Streaming replies, deep thinking, smart search, link reading, and source citations; stop generation or continue eligible replies.
- Upload, paste, or drag and drop attachments; use voice input and read replies aloud. A live audio spectrum appears in the first row of the input area while recording on mobile.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import and export.

## Data and storage

Settings and conversations are stored in D1 under the Cloudflare Access identity. API keys are encrypted by the Worker before storage. The sidebar loads conversation summaries in pages as you scroll and fetches details when opened. Attachments use SHA-256 R2 object keys so identical content is stored once; an object is deleted after its last conversation reference is removed. On first sign-in, existing browser IndexedDB conversations and attachments are migrated to that identity. Sending messages, uploading attachments, and using speech features sends the relevant content to the configured API service.

History import and export in Settings use ZIP archives. After confirmation and successful validation, importing replaces all cloud conversations and attachments for the current identity. Exports include conversations and available original images, but exclude API keys, settings, and original non-image attachments. See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format and preservation details.

Settings → Data → Delete all chats clears the current identity's cloud conversations and unsent drafts, and deletes R2 and DeepSeek Files API files that are no longer referenced by any chat. It stops ongoing replies and returns to a new chat. Your API key and settings are preserved. If a DeepSeek file deletion fails, the app asks you to check your API key or network.

## Development

| Command       | Description                  |
| ------------- | ---------------------------- |
| `pnpm dev`        | Start the frontend dev server            |
| `pnpm worker:dev` | Start the local Worker and D1/R2 emulators |
| `pnpm build`      | Build into `dist/`                        |
| `pnpm deploy`     | Build and deploy the Worker               |
| `pnpm type`       | Run TypeScript type checks                |
| `pnpm lint`       | Lint with oxlint                          |
| `pnpm format`     | Format with oxfmt                         |

[rspack.config.ts](rspack.config.ts) uses `https://api.deepseek.com` by default. Use `createConfig({ apiOrigin, devServer })` to customize the API origin and development server proxy.

Chat uses `deepseek-flash` by default through Anthropic-compatible Messages / Files APIs. Speech features use ASR / TTS endpoints. Requests include extensions for search, link reading, titles, and `latest_reminder`, so the configured service must support the corresponding capabilities. Supported attachment formats are determined by server-side validation.

```text
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               API requests, SSE, and protocol types
    chat/              Conversations, message branches, cloud storage, and history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    speech/            Audio recording and read-aloud playback
  utils/               Shared utilities
worker/                Cloudflare Worker API
migrations/            D1 schema and indexes
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
