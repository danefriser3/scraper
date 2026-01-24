# Scraper on Vercel

This project deploys two Serverless Functions on Vercel and runs a daily cron job to scrape Aldi products and upload them to MinIO/S3.

## Functions
- GET /api/scrape — triggers `scrapeAndUpload()` and uploads JSON to S3/MinIO
- GET /api/health — checks MinIO health via `s3Health()`

## Cron Schedule
Configured in `vercel.json`:
- Daily at 00:00 UTC: `0 0 * * *` hitting `/api/scrape`

You can change the schedule in `vercel.json` (e.g., `*/5 * * * *` for every 5 minutes).

## Environment Variables
Set these in Vercel Project → Settings → Environment Variables:
- `S3_ENDPOINT` — e.g. `https://minio-hfis.onrender.com`
- `S3_REGION` — default `us-east-1`
- `S3_ACCESS_KEY` — MinIO/S3 access key
- `S3_SECRET_KEY` — MinIO/S3 secret key
- `S3_BUCKET` — e.g. `products`
- `INGESTOR_URL` — optional, wakes up external ingestor

## Deploy (GitHub)
1. Push this repo to GitHub (e.g., `danefriser3/scraper`).
2. In Vercel, create a new project from the repo.
3. Root Directory: project root (where `api/` and `vercel.json` live).
4. Set the environment variables.
5. Deploy. After the first invocation, the **Functions** tab will show the functions.

## Deploy (CLI)
```bash
npm i -g vercel
vercel link    # select or create a project
vercel env add S3_ENDPOINT production
vercel env add S3_REGION production
vercel env add S3_ACCESS_KEY production
vercel env add S3_SECRET_KEY production
vercel env add S3_BUCKET production
vercel deploy
```

## Trigger & Logs
- Manually trigger: `https://<project>.vercel.app/api/scrape` and `https://<project>.vercel.app/api/health`
- Logs (Dashboard): Project → Functions → select `api/scrape` or `api/health`
- Logs (CLI):
```bash
vercel logs <project-name> --source=function --since 24h
```

## Local Dev
```bash
npm i
vercel dev
# Then visit http://localhost:3000/api/health or /api/scrape
```
