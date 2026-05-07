# AtomFlow

## Project Overview

AtomFlow 是一个前后端一体化的知识工作台，把内容消费流程（RSS 订阅）转成可复用知识资产（原子卡片）。

- 输入层：今日推送（RSS 聚合 + 全文抓取）
- 沉淀层：知识库（原子卡片 — 观点/数据/金句/故事）
- 输出层：写作页（素材召回与生成）

## Tech Stack

- Frontend: React 18 + Vite + TypeScript + Tailwind (class-based)
- Backend: Express (same process as frontend dev server) + RSS Parser + Readability + JSDOM
- Database: PostgreSQL (via `pg` pool, no ORM); optional pgvector for future semantic search
- AI: OpenAI-compatible API (qwen3.6-plus via third-party relay) for card extraction and writing Chat assistant
- Auth: express-session + bcrypt
- Email: Resend API / Gmail SMTP
- Runtime: Node.js 18+
- Deployment: Railway (Nixpacks) + GitHub auto-deploy

## Key Paths

- Entry: `server.ts` — all backend API routes, RSS fetch, DB schema creation
- Global state: `src/context/AppContext.tsx`
- Navigation + source layout: `src/components/Nav.tsx`
- Feed page: `src/pages/FeedPage.tsx`
- Knowledge page: `src/pages/KnowledgePage.tsx`
- Write page: `src/pages/WritePage.tsx`
- Discover page: `src/pages/DiscoverPage.tsx`
- Article display utils: `src/utils/articleDisplay.ts`
- Types: `src/types.ts`
- Tests: `tests/`

## Development Commands

- `npm run dev` — Start dev server (default port 3001; local `.env` may set `PORT=3002`)
- `npx tsc --noEmit` — Type check
- `npm run lint` — Lint
- `npm run build` — Production build
- `npx tsx tests/subscriptions.test.ts` — Run subscription integration tests

## Coding Standards

- TypeScript strict mode; no `any` in new code unless truly necessary
- All DB operations directly via `pool.query` (no ORM) — parameterized queries only
- `asyncHandler` wrapper on all Express routes that use async/await
- `requireAuth` middleware on all routes needing login
- Built-in RSS sources (BUILTIN_SOURCE_NAMES) go to global in-memory store; custom sources for logged-in users go to `user_subscriptions` + `user_articles` tables
- Saved articles persist to `saved_articles` table; cards link back via `saved_article_id`
- AI card extraction (`extractCardsWithAI`) falls back to regex (`buildCardsFromArticleContent`) on failure unless `DISABLE_AI_FALLBACK=true`
- `loadPreferences` must complete before `loadUserSubscriptions` to avoid localStorage race
- No `window.location.reload()` unless truly necessary — prefer state-driven updates

## Database Tables

| Table | Purpose |
|-------|---------|
| `users` | User accounts |
| `verification_codes` | Email OTP for login/register |
| `saved_articles` | Persisted original articles when user saves to knowledge base |
| `saved_cards` | Atom cards (观点/数据/金句/故事) with origin (ai/manual) and saved_article_id FK |
| `card_relations` | Knowledge graph edges (reserved for future: supports/conflicts/extends) |
| `user_preferences` | Theme, view mode, source layout |
| `notes` | User notes |
| `user_subscriptions` | Custom RSS subscriptions |
| `user_articles` | Articles from custom subscriptions |
| `session` | Express session store (auto-created by connect-pg-simple) |

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SESSION_SECRET` | Yes (prod) | Session cookie signing |
| `AI_API_KEY` | Yes | OpenAI-compatible API key for card extraction |
| `AI_BASE_URL` | Yes | API base URL (e.g. https://api-us.aiznt.com) |
| `AI_MODEL` | Yes | Model name (e.g. qwen3.6-plus) |
| `DISABLE_AI_FALLBACK` | Optional | Set `true` to fail saves when AI extraction fails, used to verify real AI atomization |
| `RESEND_API_KEY` | Optional | Resend email API |
| `SMTP_USER` / `SMTP_PASS` | Optional | Gmail SMTP (alternative to Resend) |
| `BAIDU_TRANSLATE_APPID` / `BAIDU_TRANSLATE_KEY` | Optional | Baidu Translate API |
| `RSSHUB_BASE` | Optional | Custom RSSHub mirror URL |

## Railway / Cloud Notes

- Production deployment platform: Railway.
- Railway should use `railway.json`; add the Railway PostgreSQL plugin so `DATABASE_URL` is injected.
- Configure secrets in Railway Variables only. Never commit real API keys or service secrets.
- Required Railway variables:

```env
DATABASE_URL=postgresql://...
SESSION_SECRET=...
AI_API_KEY=...
AI_BASE_URL=https://api-us.aiznt.com
AI_MODEL=qwen3.6-plus
NODE_ENV=production
```

- Optional Railway variables:

```env
RSSHUB_BASE=https://rsshub.app
RESEND_API_KEY=...
SMTP_USER=...
SMTP_PASS=...
BAIDU_TRANSLATE_APPID=...
BAIDU_TRANSLATE_KEY=...
VOLCENGINE_ASR_APPID=...
VOLCENGINE_ASR_TOKEN=...
VOLCENGINE_ASR_CLUSTER=volcengine_streaming_common
```

## AI Extraction And Chat

Knowledge atomization and the writing Chat assistant must use the same OpenAI-compatible configuration:

```env
AI_API_KEY
AI_BASE_URL
AI_MODEL
```

The backend calls:

```text
{AI_BASE_URL}/v1/chat/completions
```

Keep `AI_BASE_URL` without `/v1` at the end.

For debugging whether atomization is really using the remote AI API, set:

```env
DISABLE_AI_FALLBACK=true
```

When enabled, AI extraction failure makes `/api/articles/:id/save` return `502` instead of creating rule-based fallback cards. Use this for local debugging or temporary staging checks; do not enable in production unless saves should fail when the AI provider is unavailable.

## Local Test Account

Current local PostgreSQL test user:

```text
email: test@atomflow.local
nickname: 测试用户
password: not set in local database
```

The local test user currently has no password hash. Use OTP/login flows, local DB setup, or test helpers as needed.

Some test scripts define default credentials:

```text
tests/save-to-knowledge.test.ts: test@atomflow.local / test123
tests/subscriptions.test.ts: test@example.com / test123456
```

The local database currently contains `test@atomflow.local`, not `test@example.com`.

## Save To Knowledge Flow

Clicking "原子化存入知识库" calls the backend:

```text
GET  /api/articles/:id/full
POST /api/articles/:id/save
```

The backend then:

1. Finds the article by ID.
2. Fetches/normalizes full content.
3. Calls AI atomization through `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL`.
4. Stores the original article in `saved_articles`.
5. Stores atom cards in `saved_cards`.

The frontend does not write directly to the database and does not call the AI provider directly.

Known local debug notes:

- A `404 Article not found` during save usually means the frontend has a stale article ID.
- RSS article IDs should be generated from stable article identity instead of `Date.now()`.
- The frontend save path retries by matching article URL/title if an ID becomes stale.
- `/api/write/agent/chat` returning `404` means the running server process is stale and must be restarted.
- `/api/write/agent/chat` returning `401` means the route exists and the user is not logged in.

## Git Conventions

- Branch naming: `feat/xxx`, `fix/xxx`, `refactor/xxx`
- Commit messages: conventional commits (feat/fix/refactor/chore)
- Never commit `.env` files

## Automation Behavior Rules

After every code change, proactively run the following — do not wait to be asked:

1. **Auto type check**: After every `.ts` / `.tsx` change, run `npx tsc --noEmit` to verify no type errors
2. **Auto quality check**: After completing a feature or fix, invoke the `quality-gate` sub-agent
3. **Auto DB review**: After modifying `server.ts` schema or query code, invoke the `db-analyzer` sub-agent
4. **Auto code review**: After completing a significant feature, invoke the `code-reviewer` sub-agent
5. **Auto fix**: If a sub-agent finds issues, fix them directly — do not ask the user unless architectural decisions are required

For cross-module tasks, create agent teams for parallel work.

## Collaboration Mode

- Prefer autonomous decisions; minimize questions
- Fix discovered issues directly rather than listing them
- Sub-agents run in the background (background: true) to avoid blocking
