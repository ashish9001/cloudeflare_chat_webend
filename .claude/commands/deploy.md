# Deploy Agent

Deploy the Cloudflare Workers chat server after pre-flight checks.

## Pre-flight Checks

1. **TypeScript** — Run `npm run typecheck`. Do NOT deploy if there are type errors.
2. **Review changes** — Show a summary of what's being deployed (git diff if available).
3. **Confirm target** — Ask the user: staging or production?

## Deploy

- **Staging**: `npm run deploy:staging`
- **Production**: `npm run deploy`

## Post-deploy

1. Verify the deployment was successful from the command output.
2. Tail logs briefly to check for errors: `npm run tail` (run in background, check for ~10 seconds).
3. Report deployment status.

If deployment fails:
- Check for wrangler auth issues
- Check for compatibility date issues
- Check for DO migration issues
- Report the exact error to the user

$ARGUMENTS
