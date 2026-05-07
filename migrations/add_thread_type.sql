-- Migration: Add thread_type column to write_agent_threads
-- Date: 2026-05-07

-- Add thread_type column with default 'chat'
ALTER TABLE write_agent_threads
ADD COLUMN IF NOT EXISTS thread_type TEXT NOT NULL DEFAULT 'chat'
CHECK (thread_type IN ('chat', 'skill'));

-- Create index for filtering by thread type
CREATE INDEX IF NOT EXISTS idx_write_agent_threads_type
ON write_agent_threads(user_id, thread_type, updated_at DESC);

-- Update existing threads to be 'chat' type (already default, but explicit)
UPDATE write_agent_threads
SET thread_type = 'chat'
WHERE thread_type IS NULL OR thread_type = '';
