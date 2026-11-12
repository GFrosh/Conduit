# Deployment

The service is a stateless HTTP process. Anything that can run a container or a Node process behind a
load balancer can host it; nothing here assumes a particular platform.

---

## 1. Build an artifact

```bash
npm ci
npm run verify        # typecheck + lint + 278 tests
npm run build         # dist/
```

Ship `dist/`, `package.json`, `package-lock.json`, `node_modules` (production only) and `docs/`.

## 2. Container

```bash
docker build -t ai-processing-engine:0.1.0 .
docker run --rm -p 3000:3000 --env-file .env.production ai-processing-engine:0.1.0
```

| Property | Value |
| --- | --- |
| Base image | `node:22-alpine`, multi-stage |
| User | `node` (non-root) |
| Init | `tini` — forwards `SIGTERM` so graceful shutdown fires |
| Content | compiled `dist/`, production `node_modules`, `docs/`. No tests, no TypeScript, no dev deps |
| Healthcheck | `GET /health`, 30 s interval, 3 s timeout, 3 retries, 10 s start period |
| Signal | `CMD ["node","dist/server.js"]` behind `tini` |

Compose example:

```yaml
services:
  engine:
    image: ai-processing-engine:0.1.0
    env_file: .env.production
    ports: ["3000:3000"]
    read_only: true
    tmpfs: ["/tmp"]
    security_opt: ["no-new-privileges:true"]
    stop_grace_period: 25s
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 3s
      retries: 3
```

## 3. Bare Node

```bash
NODE_ENV=production node dist/server.js
```

Run under a supervisor that forwards `SIGTERM` (systemd `KillSignal`, supervisord `stopsignal`, or a
process manager with signal forwarding). Without signal forwarding the graceful path never runs.

## 4. Probes

| Probe | Path | Success | Failure |
| --- | --- | --- | --- |
| Liveness | `GET /health` | `200` | any non-200 ⇒ restart the instance |
| Readiness | `GET /ready` | `200` `status: "ready"` | `503` ⇒ remove from the load balancer, do **not** restart |

Readiness fails when no provider is registered (`no_providers_registered`) or the default provider is
missing (`default_provider_unavailable`). Both mean the deployment is misconfigured, so a restart will
not help — inspect configuration.

Point liveness at `/health` in the container runtime and readiness at `/ready` in the load balancer.
Reversing them produces restart loops on a config error.

## 5. Graceful shutdown

`SIGTERM` / `SIGINT`:

1. Log the signal, stop accepting new connections.
2. Drain in-flight requests for up to **15 s**.
3. Exit `0` on a clean drain, `1` on timeout or close failure.
4. A **second** signal exits `1` immediately — an operator is never blocked by a hung connection.

Set the platform's termination grace period to **at least 20 s** (15 s drain + scheduler slack). Below
that, the supervisor sends `SIGKILL` mid-response and clients see truncated connections.

## 6. Scaling

- **Horizontal.** No shared state: no database, no cache, no session.
- **Rate limits are per instance.** N replicas ⇒ effectively N × `RATE_LIMIT_MAX`. If you need a global
  cap, terminate limits at the gateway (recommended) or introduce a shared store (deliberately out of
  scope).
- **Fallback and retries** are per request, so they scale with instances without coordination.
- **Cold start** is fast: no warm-up calls, no model loading.

## 7. Network

| Direction | Requirement |
| --- | --- |
| Ingress | TLS terminated in front of the service (it speaks plain HTTP). Forward `Authorization` and `x-request-id` unchanged |
| Egress | HTTPS to `api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com` (whichever providers you enable) |
| Proxy | `trustProxy` is `false`. Behind a proxy, per-client rate limiting still works via the client id; IP fallback would see the proxy address. Enable `AUTH_ENABLED` in any multi-tenant deployment |

## 8. Secrets

| Secret | Delivery |
| --- | --- |
| `*_API_KEY` | Secret manager / orchestrator secret, injected as env at boot |
| `SERVICE_API_KEYS` | Secret manager. Prefer pre-hashed 64-hex secrets so plaintext never exists in the environment |

Never in the image, never in a config file in the repo, never in a request. Rotation currently requires
a restart (see the limitations list in `README`).

## 8a. Key rotation procedure

```bash
# Add the new key alongside the old, rolling-restart.
SERVICE_API_KEYS=old-key:<secret>,new-key:<secret>
# Migrate clients, then remove the old entry and restart again.
```

Both keys are valid during the overlap, so rotation needs no downtime.

## 9. Rollout and rollback

```bash
# Roll out
docker build -t ai-processing-engine:0.1.1 .
# Deploy, watch /ready, then shift traffic.

# Roll back
# Redeploy the previous image tag. No schema or state migrations exist,
# so rollback is purely a version swap.
```

Stateless by design: there is no migration to reverse, and an interrupted rollout leaves no partial
state.

## 8. Verification after deploy

```bash
curl -fsS https://<host>/health
curl -sS -o /dev/null -w '%{http_code}\n' https://<host>/ready
curl -sS -X POST https://<host>/v1/process \
  -H "Authorization: Bearer $CLIENT_KEY" -H 'content-type: application/json' \
  -d '{"instructions":"Reply with the word ok.","content":{"type":"text","text":"ping"},"output":{"format":"text"}}'
```

Expect `200`, `200`, and a normalized success body naming the provider that answered.

## 10. Capacity notes

| Concern | Guidance |
| --- | --- |
| Memory | Bounded by `MAX_BODY_BYTES` × concurrent requests; 1 MiB default is far above realistic article sizes |
| Connections | `connectionTimeout` 30 s, `keepAliveTimeout` 72 s, `requestTimeout` = request budget + 5 s |
| Latency | Dominated by the provider. `meta.timings.provider_ms` isolates it from service overhead |
| Cost control | `max_output_tokens` per request, `MAX_OUTPUT_TOKENS_*` per deployment, rate limit per client |
