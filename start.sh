#!/bin/bash
# ──────────────────────────────────────
#  OpenClaw Dashboard — Quick Launcher
# ──────────────────────────────────────

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=3001
URL="http://localhost:$PORT"

echo ""
echo "  🦞 Starting OpenClaw Dashboard..."
echo "  ──────────────────────────────────"

# Check for Node.js
if ! command -v node &> /dev/null; then
  echo "  ❌ Node.js is not installed. Please install it first."
  exit 1
fi

# Kill any existing instance on the port
if lsof -ti:$PORT &> /dev/null; then
  echo "  ⚠️  Port $PORT in use — stopping previous instance..."
  kill $(lsof -ti:$PORT) 2>/dev/null
  sleep 1
fi

# Start the server in the background
cd "$DIR"
node server.js &
SERVER_PID=$!

# Wait a moment for the server to start
sleep 1

# Check if server started successfully
if ! kill -0 $SERVER_PID 2>/dev/null; then
  echo "  ❌ Server failed to start. Check the logs above."
  exit 1
fi

echo ""
echo "  ✅ Server running (PID: $SERVER_PID)"
echo "  📊 Opening dashboard at $URL"
echo ""
echo "  Press Ctrl+C to stop the server."
echo ""

# Open the dashboard in the default browser
if [[ "$OSTYPE" == "darwin"* ]]; then
  open "$URL"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
  xdg-open "$URL" 2>/dev/null || echo "  Open $URL in your browser"
fi

# Wait for the server process and handle Ctrl+C
trap "echo ''; echo '  🛑 Shutting down...'; kill $SERVER_PID 2>/dev/null; exit 0" INT TERM
wait $SERVER_PID
