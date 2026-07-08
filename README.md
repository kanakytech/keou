# Keou — Open-Source Studio

**Turn one raw product photo into professional commercial visuals — images and videos — in minutes.**

This is the open-source edition of [Keou](https://keou.systems): a self-hostable production
studio for AI product visuals. No account system, no billing — you paste your own
[KIE.AI](https://kie.ai) API key in the studio and pay the provider directly.

![studio](public/showcase/4.png)

## What's in this edition

- **Image generation** — drop a product photo, get a commercial-grade scene around it
  (the product itself stays pixel-locked: shape, text, labels, logos untouched)
- **Video generation** — cinematic product clips from a still, with a choice of engines
  (Grok Imagine, Kling 2.6/3.0, Seedance 2, Veo 3)
- **Batch studio** — queue dozens of generations in parallel with live progress
- **Projects & campaigns** — organize output by client and campaign
- **No accounts** — open the studio, paste a key, produce

The full production suite — polish, remix, format adaptation, 30-variant export packs,
voice-overs, sound effects, 8K upscaling, team workspaces, client approval portals,
white-label — ships with [Keou Enterprise](https://keou.systems/pro.html).

## Quick start

### Requirements

- Node.js ≥ 20
- PostgreSQL (any recent version)
- A [KIE.AI](https://kie.ai) API key (each user pastes their own in the studio)
- A Cloudflare R2 bucket (free tier is fine) — used to store your uploads and results
  durably (provider URLs expire after ~14 days)

### Run it

```bash
git clone https://github.com/kanakytech/keou.git
cd keou
npm ci
cp .env.example .env   # fill in DATABASE_URL, JWT_SECRET, R2_*
npm start
```

Open http://localhost:3401 — the studio loads directly, no login. Paste your KIE.AI
key in the key bar (it stays in your browser and rides each request; the server never
stores it).

### Deploy on Railway

1. New project → Deploy from GitHub → this repo (or your fork)
2. Add a PostgreSQL service — `DATABASE_URL` is injected automatically
3. Set the environment variables from `.env.example` (`JWT_SECRET`, `R2_*`)
4. Done — the Dockerfile and healthcheck are already configured

### Docker

```bash
docker build -t keou .
docker run -p 3401:3401 --env-file .env keou
```

## Staying up to date

This repository is automatically kept in sync with the Keou core: every improvement to
the shared engine (studio, generation pipeline, providers, security fixes) lands here as
a new commit on `main`.

- **Railway (GitHub deploy):** enable auto-deploy on `main` — updates ship themselves.
- **Self-host:** `git pull && npm ci && restart`.

Please open issues here; pull requests are welcome for the open-source surface.

## How the key handling works

Your KIE.AI key is stored in your browser's localStorage only. Each generation request
carries it in an `X-Provider-Key` header; the server uses it for that single call and
never writes it to disk, database, or logs.

## License

[MIT](LICENSE) © Kanaky Tech / Keou Systems

---

Built in Auckland by [Kevyn Wahuzue](https://www.linkedin.com/in/kevyn-wahuzue) ·
[keou.systems](https://keou.systems)
