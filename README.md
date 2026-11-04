# InstaPay Realtime Hub

The hub runs an Express API and Socket.IO server. Fly.io runs it as a persistent Node service and supports both Socket.IO WebSocket and polling transports.

## Deploy to Fly.io

1. Install `flyctl`, authenticate with `fly auth login`, and make sure the Fly app named `instapay-realtime-hub` is available to your account. The app name and London region (`lhr`) are set in `fly.toml`.
2. In the Fly dashboard, configure the app's secrets and environment:
   - `SUPABASE_URL` and `SUPABASE_ANON_KEY` for the project's Supabase client.
   - `SUPABASE_SERVICE_ROLE_KEY` for server-side fulfilment access. Keep it only in Fly secrets; never put it in a frontend environment.
   - `FULFILMENT_TOKEN_ENCRYPTION_KEY`, a private random secret of at least 32 characters, for participant links.
   - For Fleetbase order creation, set `FLEETBASE_API_KEY`, `FLEETBASE_LOCATION_NAME`, `FLEETBASE_LOCATION_ADDRESS`, `FLEETBASE_LOCATION_LATITUDE`, and `FLEETBASE_LOCATION_LONGITUDE`.
   - Set `FULFILMENT_APP_URL` and `CUSTOMER_APP_URL` to the public frontend URLs used in participant and collateral links.
   - Optional integration settings include `FLEETBASE_ORDERS_URL`, `FLEETBASE_LOCATION_ID`, `FLEETBASE_CONSOLE_URL`, `FLEETBASE_WEBHOOK_TOKEN`, `SHIPDAY_WEBHOOK_TOKEN`, `FULFILMENT_INSURANCE_RATE_PCT`, `FULFILMENT_SELLER_PAYOUT_URL`, and `FULFILMENT_SELLER_PAYOUT_KEY`.
3. From this repository's root, run `fly deploy`. Fly builds the Dockerfile and checks `/health` on port `3001`.
4. Keep exactly one machine running: run `fly scale count 1` if the app has more than one. The hub's Socket.IO sessions and some dashboard state are held in memory; multiple machines without a shared Socket.IO adapter can cause polling `400` errors and inconsistent realtime events. The Fly configuration disables autostop and keeps one machine running.
5. Verify `https://instapay-realtime-hub.fly.dev/health` returns a healthy response. Check `fly status` and `fly logs` if the deployment does not become healthy.
6. In the MFI frontend's deployment environment, set `VITE_HUB_URL` to `https://instapay-realtime-hub.fly.dev` and rebuild/redeploy the frontend. This is the step that switches the browser away from the old hub host.

For the included GitHub Actions workflow, add a Fly deploy token as the repository secret `FLY_API_TOKEN`. Pushes to `main` or `master` will then deploy the hub.

Fly.io is a persistent host, so this should address the likely serverless/session-affinity cause of the Socket.IO errors. It will not fix clients that still point at the old URL, missing Supabase/Fleetbase configuration, or unrelated network issues. Clients may briefly reconnect during a deployment.

Shop payment authorization and creator orders in Sumthing are handled through Supabase; this Socket.IO connection provides live updates to the MFI dashboard. The existing `render.yaml` remains available for a Render deployment if needed.
