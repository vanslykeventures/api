# API

This project exposes serverless endpoints at `/`, `/api/external/[...path]`, `/api/umpbot`, `/api/ping`, `/api/redis`, and `/api/push-reminders`.

## Run
Run with `npx vercel dev`

## Endpoints

- `POST /api/umpbot`
- Body fields (JSON):
  - `season`
  - `sport`
  - `age_range`
  - `teeball_level`
  - `question`
  - `message`
  - `action` (optional)
    - `seed_pdf_cache` to parse all PDFs under `files/` and save each PDF text as its own Redis entry

It returns:

```json
{ "text": "..." }
```

- `GET /api/ping`

It returns:

```json
{ "pong": true }
```

- `GET|POST /api/push-reminders`
  - dormant push reminder worker scaffold
  - reads Supabase push settings and returns a dry-run window
  - does not send pushes until the worker is explicitly activated
  - optional POST body: `{"dryRun": true, "windowMinutes": 10, "now": "2026-05-25T12:00:00Z"}`

- `GET /`

It returns:

```json
{
  "message": "Hi, this is just an API.",
  "endpoints": ["/api/ping", "/api/umpbot", "/api/redis", "/api/push-reminders", "/api/external/[...path]"]
}
```

## Environment Variables

- `GEMINI_API_KEY` (required)
- `REDIS_URL` (required for `/api/redis`)
- `REDIS_KEY_PREFIX` (optional, default: `umpbot:dev:`)
- `UMPBOT_SEED_PDF_ROOT` (optional, default: `../files`)

#### Set In Vercel
- `EWYBSL_SOURCE_BASE_URL` (required for `/api/external/[...path]`)
- `EWYBSL_SOURCE_API_KEY` (required for `/api/external/[...path]`)
- `SUPABASE_URL` (required for `/api/push-reminders`)
- `SUPABASE_SERVICE_ROLE_KEY` (required for `/api/push-reminders`)
- `PUSH_REMINDER_CRON_SECRET` (optional, requires `X-Cron-Secret` when set)

## External Proxy Route

- `GET|POST|PUT|PATCH|DELETE /api/external/[...path]`
- proxies requests to `${EWYBSL_SOURCE_BASE_URL}/api/[...path]`
- injects the upstream `apikey` server-side
- forwards `token`, `authorization`, `impersonate`, `userid`, and `password` headers as needed
- intended for the mobile app so the EWYBSL API key never ships in the client bundle

## Redis Route

- `GET /api/redis`
  - checks connectivity with Redis `PING`
- `POST /api/redis`
  - body:
    - `{"action":"set","key":"test","value":"hello","ttl_seconds":300}`
    - `{"action":"get","key":"test"}`
    - `{"action":"del","key":"test"}`

## Example Request

```bash
curl -X POST http://localhost:3000/api/umpbot \
  -H "Content-Type: application/json" \
  -d '{
    "season": "Spring",
    "sport": "Baseball",
    "age_range": "U12",
    "question": "A runner left early on a caught fly ball. Is this an out?"
  }'
```

## Seed All PDFs Into Redis

```bash
curl -X POST http://localhost:3000/api/umpbot \
  -H "Content-Type: application/json" \
  -d '{"action":"seed_pdf_cache"}'
```
