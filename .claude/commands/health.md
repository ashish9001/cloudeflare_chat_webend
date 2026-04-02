# Health Check Agent

Run a comprehensive health check on the local dev server.

## Checks

1. **Server running** — Check if wrangler dev is running on port 8787:
   ```
   lsof -i :8787
   ```

2. **Health endpoint** — Hit the health endpoint:
   ```
   curl -s http://localhost:8787/health
   ```

3. **TypeScript** — Run type checking:
   ```
   npm run typecheck
   ```

4. **Report status**:
   - Server: running/stopped
   - Health endpoint: responding/not responding
   - TypeScript: clean/has errors (list them)
   - Recommendation: restart if issues found, or all good

If the server is not running and the user seems to need it, offer to start it with `/restart`.

$ARGUMENTS
