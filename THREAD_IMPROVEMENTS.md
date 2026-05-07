# Thread History Improvements

## Overview

This document describes the improvements made to the thread history system in AtomFlow, implementing two key features:

1. **Improved thread naming**: Thread titles now use the user's first question instead of generic "新的写作会话"
2. **Separated thread histories**: Chat assistant and Skills assistant now have separate thread histories

## Changes Made

### 1. Database Schema Changes

#### Added `thread_type` column to `write_agent_threads` table

```sql
ALTER TABLE write_agent_threads
ADD COLUMN thread_type TEXT NOT NULL DEFAULT 'chat' CHECK (thread_type IN ('chat', 'skill'));

CREATE INDEX idx_write_agent_threads_type
ON write_agent_threads(user_id, thread_type, updated_at DESC);
```

**Migration**: Run `migrations/add_thread_type.sql` on existing databases.

### 2. Backend Changes (`server.ts`)

#### Updated API Endpoints

- **GET `/api/write/agent/threads`**: Now accepts `?type=chat` or `?type=skill` query parameter to filter threads by type
- **POST `/api/write/agent/threads`**: Now accepts `threadType` in request body to create threads of specific type
- **GET `/api/write/agent/threads/:id/messages`**: Now returns `thread_type` in response

#### Thread Creation

All thread creation points now specify `thread_type = 'chat'` by default:
- Line 1764: Stream-based chat creation
- Line 4693: Manual thread creation API
- Line 5162: Auto-created threads during chat

#### Thread Title Generation

The `inferThreadTitle` function (line 1521) already extracts the first 24 characters from the user's message. This is now consistently applied when creating new threads, replacing the generic "新的写作会话" default.

### 3. Frontend Changes

#### Type Definitions (`src/types.ts`)

Updated `WriteAgentThread` interface:

```typescript
export interface WriteAgentThread {
  id: number;
  title: string;
  summary?: string;
  state?: WriteAgentThreadState;
  thread_type: 'chat' | 'skill';  // NEW
  created_at: string;
  updated_at: string;
}
```

#### Context (`src/context/AppContext.tsx`)

Updated functions to support thread types:

```typescript
loadAssistantThreads: (threadType?: 'chat' | 'skill') => Promise<WriteAgentThread[]>
createAssistantThread: (threadType?: 'chat' | 'skill') => Promise<WriteAgentThread | null>
```

#### WritePage (`src/pages/WritePage.tsx`)

**New State**:
- `showChatHistory`: Controls visibility of chat thread history panel
- `showSkillHistory`: Controls visibility of skill thread history panel (reserved for future)

**New Functions**:
- `handleSwitchThread(threadId)`: Switches to a different thread and loads its messages
- Updated `handleCreateAssistantThread(threadType)`: Now accepts thread type parameter

**UI Changes**:
- Added collapsible "历史对话" section in Chat assistant panel
- Thread list shows all chat threads with current thread highlighted
- Clicking a thread switches to that conversation
- Thread titles now show the user's first question instead of generic text

## User Experience

### Before
- All threads named "新的写作会话"
- No way to distinguish between different conversations
- No thread history UI
- Chat and skill threads mixed together

### After
- Threads named after user's first question (e.g., "给我一条适合开头的知识路径")
- Clear thread history panel with collapsible UI
- Easy switching between past conversations
- Separate histories for chat vs skills (foundation laid)

## Testing

### Manual Testing Steps

1. **Test thread creation with custom title**:
   ```bash
   # Start dev server
   npm run dev
   
   # Open WritePage, send a message
   # Verify thread title matches your first question
   ```

2. **Test thread history UI**:
   - Click "历史对话" to expand/collapse
   - Create multiple threads with different first messages
   - Verify each thread shows its unique title
   - Click different threads to switch between them

3. **Test thread type filtering**:
   ```bash
   # In browser console
   fetch('/api/write/agent/threads?type=chat').then(r => r.json()).then(console.log)
   fetch('/api/write/agent/threads?type=skill').then(r => r.json()).then(console.log)
   ```

### Database Migration Testing

For existing databases:

```bash
# Connect to your PostgreSQL database
psql $DATABASE_URL

# Run migration
\i migrations/add_thread_type.sql

# Verify
SELECT id, title, thread_type FROM write_agent_threads LIMIT 5;
```

## Future Enhancements

1. **Skills thread history**: Add similar UI for Skills assistant when skill-based conversations are implemented
2. **Thread search**: Add search/filter functionality for finding specific conversations
3. **Thread deletion**: Add UI to delete old threads
4. **Thread export**: Export conversation history as markdown
5. **Thread tags**: Allow users to tag threads for better organization

## Rollback

If issues occur, rollback steps:

1. **Database**: Remove the column (data loss)
   ```sql
   ALTER TABLE write_agent_threads DROP COLUMN IF EXISTS thread_type;
   DROP INDEX IF EXISTS idx_write_agent_threads_type;
   ```

2. **Code**: Revert commits related to this feature

## Notes

- The `inferThreadTitle` function truncates to 24 characters to keep titles concise
- Thread type defaults to 'chat' for backward compatibility
- Existing threads will be treated as 'chat' type after migration
- The Skills assistant UI is prepared for thread history but not yet fully implemented
