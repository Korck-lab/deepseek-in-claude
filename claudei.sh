
#!/bin/bash
echo "🚀 Checking update ..."
~/.local/bin/claude update

echo "🚀 Starting claude code irrestrict..."
ANTHROPIC_BASE_URL=http://localhost:8787 claude --dangerously-skip-permissions --autocompact 350k \
   --append-system-prompt "Be terse while keep information density. Forward terseness instruction to all sub-agents" \
   $@
