# API

This project exposes serverless endpoints at `/`, `/api/umpbot`, and `/api/ping`.

## Endpoint

- `POST /api/umpbot`
- Body fields (JSON):
  - `season`
  - `sport`
  - `age_range`
  - `teeball_level`
  - `question`
  - `message`

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
  "endpoints": ["/api/ping", "/api/umpbot"]
}
```

## Environment Variables

- `GEMINI_API_KEY` (required)
- `GEMINI_MODEL` (optional, default: `gemini-2.5-flash`)
- `REDIS_URL` (optional, enables PDF text caching)
- `UMPBOT_PDF_ROOT` (optional)
  - defaults to `../../wybsl_mobile/files/UmpBot` relative to `api/api/umpbot.js`

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
