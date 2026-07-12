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
- AI: OpenAI-compatible API (MiMo Token Plan) for card extraction and default writing Agent model; OpenAI Agents SDK for writing Agent runtime
- Auth: express-session + bcrypt
- Email: Resend API / Gmail SMTP
- Runtime: Node.js 22+
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

- `npm run dev` — Start dev server on fixed local port `PORT=1000`
- `npx tsc --noEmit` — Type check
- `npm run lint` — Lint
- `npm run build` — Production build
- `npx tsx tests/subscriptions.test.ts` — Run subscription integration tests

## Port Configuration

**本地开发端口**：`PORT=1000`（避免与其他项目冲突）

- **规避端口**：8848、3004（其他项目占用）
- **前端**：通过 Vite 中间件模式集成，不单独占用端口
- **后端**：Express 服务器监听 `.env` 中的 `PORT`
- **访问地址**：http://localhost:1000
- **端口策略**：本地开发不自动切换端口；如果 `1000` 被占用，启动应失败并提示清理旧进程
- **Agent 协作约束**：不要临时改端口来绕过占用，也不要把新端口写回配置或文档

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
| `AI_BASE_URL` | Yes | API base URL (e.g. https://token-plan-sgp.xiaomimimo.com/v1) |
| `AI_MODEL` | Yes | Model name (e.g. mimo-v2.5-pro) |
| `OPENAI_API_KEY` | Optional | Official OpenAI API key override for the writing Agent runtime |
| `OPENAI_MODEL` | Optional | Official OpenAI model override for the writing Agent runtime |
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
AI_BASE_URL=https://token-plan-sgp.xiaomimimo.com/v1
AI_MODEL=mimo-v2.5-pro
NODE_ENV=production
APP_URL=https://your-domain.example
ALLOWED_ORIGINS=https://your-domain.example
VITE_TLDRAW_LICENSE_KEY=...
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

## Production Security And Scale

- Production deploys use GitHub auto-deploy to Railway. Merge only after the GitHub checks pass, and **Wait for CI** before treating a change as deployable.
- Set `SESSION_SECRET` to a minimum of 32 random characters in production. Never use the example value or commit secrets.
- Set `APP_URL` to the canonical public HTTPS URL and configure `ALLOWED_ORIGINS` to the exact browser origins that may call the app.
- Railway must use `healthcheckPath: /api/health` with an explicit `healthcheckTimeout`; a deployment is not healthy until that check passes.
- `VITE_TLDRAW_LICENSE_KEY` is a production build variable. Without it, the magic-writing canvas is intentionally disabled.
- Local and in-memory limits are development safeguards only. They do not provide shared enforcement across Railway replicas and must not be treated as production-grade rate limiting or coordination.
- Keep Railway at one web replica until global RSS state, rate limits and job coordination move to shared storage. Public launch gates: Cloudflare/WAF, Redis, object storage, a background queue, monitoring/alerting and verified database backups. Add 2+ replicas only after those shared-state migrations and a load test.

## AI Extraction And Writing Agent

Knowledge atomization uses the OpenAI-compatible MiMo Token Plan configuration:

```env
AI_API_KEY
AI_BASE_URL
AI_MODEL
```

The writing Agent runtime uses the OpenAI Agents SDK. By default it reuses the MiMo OpenAI-compatible configuration above through `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL`. To force official OpenAI instead, set:

```env
OPENAI_API_KEY
OPENAI_MODEL
```

The backend calls:

```text
{AI_BASE_URL}/chat/completions when AI_BASE_URL already ends with /v1
{AI_BASE_URL}/v1/chat/completions otherwise
```

MiMo Token Plan model IDs must be lowercase. The backend normalizes `mimo-*` model names to lowercase before sending requests.

For debugging whether atomization is really using the remote AI API, set:

```env
DISABLE_AI_FALLBACK=true
```

When enabled, AI extraction failure makes `/api/articles/:id/save` return `502` instead of creating rule-based fallback cards. Use this for local debugging or temporary staging checks; do not enable in production unless saves should fail when the AI provider is unavailable.

## Local Integration Test Account

- Real API tests read `TEST_EMAIL` and `TEST_PASSWORD` from the local shell or an uncommitted environment file.
- Never commit, document, or add fallback values for test-account credentials.
- The account must exist only in the intended local or isolated test database, never as a shared production backdoor.
- Local application URL remains `http://localhost:1000`.

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
