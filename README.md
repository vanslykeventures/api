# API

This project exposes serverless endpoints at `/`, `/api/umpbot`, `/api/ping`, and `/api/redis`.

## Run
Run with `npx vercel dev`

## Endpoint

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

- `GET /`

It returns:

```json
{
  "message": "Hi, this is just an API.",
  "endpoints": ["/api/ping", "/api/umpbot", "/api/redis"]
}
```

## Environment Variables

- `GEMINI_API_KEY` (required)
- `REDIS_URL` (required for `/api/redis`)
- `REDIS_KEY_PREFIX` (optional, default: `umpbot:dev:`)
- `UMPBOT_SEED_PDF_ROOT` (optional, default: `../files`)

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
