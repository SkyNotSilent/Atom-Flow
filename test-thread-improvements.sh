#!/bin/bash

# Test script for thread improvements
# Run this after starting the dev server with `npm run dev`

echo "Testing thread improvements..."
echo ""

# Test 1: Create a thread with custom title
echo "Test 1: Creating thread with custom title..."
RESPONSE=$(curl -s -X POST http://localhost:3001/api/write/agent/threads \
  -H "Content-Type: application/json" \
  -d '{"title": "测试线程标题", "threadType": "chat"}' \
  -c cookies.txt)

echo "Response: $RESPONSE"
THREAD_ID=$(echo $RESPONSE | grep -o '"id":[0-9]*' | grep -o '[0-9]*')
echo "Created thread ID: $THREAD_ID"
echo ""

# Test 2: List chat threads
echo "Test 2: Listing chat threads..."
curl -s http://localhost:3001/api/write/agent/threads?type=chat -b cookies.txt | jq '.'
echo ""

# Test 3: List skill threads (should be empty)
echo "Test 3: Listing skill threads..."
curl -s http://localhost:3001/api/write/agent/threads?type=skill -b cookies.txt | jq '.'
echo ""

# Test 4: Get thread messages
if [ ! -z "$THREAD_ID" ]; then
  echo "Test 4: Getting thread messages..."
  curl -s http://localhost:3001/api/write/agent/threads/$THREAD_ID/messages -b cookies.txt | jq '.thread'
  echo ""
fi

# Cleanup
rm -f cookies.txt

echo "Tests completed!"
