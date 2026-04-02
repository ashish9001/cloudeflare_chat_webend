# Server Restart Agent

Restart the local Cloudflare Workers dev server cleanly.

## Steps

1. Check if wrangler dev is currently running:
   ```
   lsof -i :8787
   ```

2. If running, kill the process:
   ```
   pkill -f "wrangler dev" || true
   ```

3. Wait briefly, then verify port is free:
   ```
   lsof -i :8787
   ```

4. Start fresh dev server in background:
   ```
   npm run dev
   ```
   Run this in background so it doesn't block.

5. Verify server is up by checking health endpoint:
   ```
   curl -s http://localhost:8787/health
   ```

6. Report the server status to the user.

If the server fails to start, check for:
- Port conflicts (another process on 8787)
- TypeScript errors (`npm run typecheck`)
- Missing dependencies (`npm install`)

$ARGUMENTS
