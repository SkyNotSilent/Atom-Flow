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
- AI: OpenAI-compatible API (qwen3.6-plus via third-party relay) for card extraction
- Auth: express-session + bcrypt
- Email: Resend API / Gmail SMTP
- Runtime: Node.js 18+, Windows 11 dev environment
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

- `npm run dev` — Start dev server (port 3001)
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
- AI card extraction (`extractCardsWithAI`) must always fallback to regex (`buildCardsFromArticleContent`) on failure
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
| `RESEND_API_KEY` | Optional | Resend email API |
| `SMTP_USER` / `SMTP_PASS` | Optional | Gmail SMTP (alternative to Resend) |
| `BAIDU_TRANSLATE_APPID` / `BAIDU_TRANSLATE_KEY` | Optional | Baidu Translate API |
| `RSSHUB_BASE` | Optional | Custom RSSHub mirror URL |

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
