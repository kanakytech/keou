<div align="center">

<img src="public/logo-keou.png" alt="Keou" width="76" height="76">

# Keou Studio

**One raw product photo in. A full commercial campaign out.**

Product images, cinematic video, voice-overs, sound design and multi-format delivery packs —
self-hosted, on your own provider key.

[![Licence](https://img.shields.io/badge/licence-MIT-c8f060?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-c8f060?style=flat-square)](https://nodejs.org)
[![Try it](https://img.shields.io/badge/try%20it-studio.kanaky.xyz-c8f060?style=flat-square)](https://studio.kanaky.xyz/launch)

[Try it without installing](https://studio.kanaky.xyz/launch) ·
[Full documentation](https://studio.kanaky.xyz/docs.html) ·
[Quick start](#quick-start) ·
[Configuration](#configuration) ·
[API](#http-api) ·
[Custom builds](#custom-builds)

</div>

---

![Keou Studio](public/docs-img/studio.png)

## Everything ships here

There is no paid tier holding features back. Polish, remix, format adaptation, export
packs, voice, sound, upscaling, teams, sharing — and the production prompt stack that
makes the output good — are all in this repository, under MIT.

Three files stay in our private repo, and none is a feature: our provider costs and
margin table, the Stripe plumbing that bills *our* hosted instance, and the operator
credit top-ups behind it. Nothing in the studio reads them.

> **Previously:** this edition was deliberately cut down — image and video only — as a
> funnel toward a licence that unlocked the rest. That funnel is gone.
>
> We still sell something, but it is a different kind of thing: the licence was money
> for **software that already existed**, and a custom build is money for **work that
> does not exist yet**. There is no price list, because there is no product to price.
> If the public build does what you need, you owe us nothing — and that is the outcome
> we expect for most people who read this.

---

## What it does

| Capability | What it means |
|---|---|
| **Product images** | Drop a photo, get a commercial scene around it. The product stays pixel-locked — shape, text, labels and logos are never redrawn. |
| **Cinematic video** | Product clips from a still. Engines: Grok Imagine, Kling 2.6 / 3.0, Seedance 2, Veo 3. |
| **Polish** | Retouch a render without regenerating it — lighting, blemishes, background cleanup. |
| **Remix** | Re-imagine an existing render in a new direction, keeping the product identical. |
| **Format adapt** | One render becomes every aspect ratio your channels need, recomposed rather than cropped. |
| **Export packs** | Platform-ready variants from a single approved visual, in one action. Three presets ship (1, 4 and 8 formats); `src/lib/packs.js` is a plain list you extend. |
| **Voice & sound** | Voice-overs and sound effects for the clips, in the same pipeline. |
| **Upscaling** | Images and video to 8K. |
| **Clients & campaigns** | Organise output by client, campaign and approval state. |
| **Share links** | Send a client a review link and collect structured feedback. |
| **Teams** | Accounts, roles and quotas for a studio of more than one. |
| **Assistant** | A chat agent that drives the whole toolset for you. Needs your own Anthropic key. |
| **Batch** | Dozens of generations queued in parallel with live progress. |

---

## Quick start

### What you need

| | |
|---|---|
| **Node.js** | ≥ 20 |
| **PostgreSQL** | any recent version |
| **A provider key** | [KIE.AI](https://kie.ai?ref=ec0e98ef53c18d6f13f05629a9ffd793) or [Fal.ai](https://fal.ai) — each user pastes their own |
| **Object storage** | A Cloudflare R2 bucket (free tier is enough). **Required to upload anything** — `POST /api/upload` returns 503 without it, and uploading a photo is the product's first move. It also keeps results alive past the ~14 days a provider URL lasts. |

### Run it

```bash
git clone https://github.com/kanakytech/keou.git
cd keou
npm ci
cp .env.example .env
npm start
```

Four values in `.env`, and the last two matter as much as the first two:

```
DATABASE_URL=postgresql://…      # your database
JWT_SECRET=…                     # openssl rand -hex 32
ADMIN_EMAIL=you@example.com      # seeds your account on first boot
ADMIN_PASSWORD=…                 # 12+ chars
```

Without `ADMIN_EMAIL` / `ADMIN_PASSWORD` the instance boots with **no way to sign in**:
public self-serve signup is off by default in a self-hosted deployment, on purpose.

Open **http://localhost:3401**, sign in, paste your provider key in the key bar and
produce.

### Docker

```bash
docker build -t keou .
docker run -p 3401:3401 --env-file .env keou
```

The image runs as a non-root user and ships a healthcheck on `/health`. It sets
`NODE_ENV=production`, which turns Postgres TLS on — if your database is local and
speaks plain TCP, add `DATABASE_SSL=0` to your `.env`.

### Railway

1. New project → **Deploy from GitHub** → this repo (or your fork)
2. Add a **PostgreSQL** service — `DATABASE_URL` is injected for you
3. Set `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` and the `R2_*` variables
4. Deploy. `railway.json` and the healthcheck are already configured.

Skip `ADMIN_EMAIL` / `ADMIN_PASSWORD` and the deploy succeeds, the healthcheck goes
green, and nobody can sign in — the database has no account to let through.

---

## How it fits together

```mermaid
flowchart LR
  B["Browser<br/><i>your provider key<br/>lives here</i>"]
  API["Express API<br/><i>routes + auth</i>"]
  ENG["Generation engine<br/><i>keou-actions</i>"]
  PR["Provider<br/><i>KIE.AI / Fal.ai</i>"]
  PG[("PostgreSQL<br/><i>users, jobs,<br/>projects</i>")]
  R2[("R2 storage<br/><i>uploads +<br/>results</i>")]
  POLL["Poller<br/><i>needs a<br/>server-side key</i>"]

  B -- "X-Provider-Key<br/>per request" --> API
  API --> ENG
  ENG -- "your key,<br/>never stored" --> PR
  ENG <--> PG
  ENG --> R2
  POLL -. "polls" .-> PR
  POLL --> PG
  POLL --> R2
  R2 -- "durable URLs" --> B
```

**The key never touches the server's disk.** It lives in your browser's `localStorage`,
rides each request in an `X-Provider-Key` header, is used for that single provider call,
and is never written to disk, database, or logs.

> **The trade-off, stated plainly.** Because the key exists only inside a request, the
> background poller has no key of its own in a bring-your-own-key deployment — it cannot
> finish a job on your behalf. Your browser drives the polling, and the result is stored
> the moment it lands. Close the tab mid-generation and the job stays pending until you
> come back (the studio picks it up again from `/api/pending`); the provider's own URL
> expires after about 14 days.
>
> If you would rather the server complete jobs unattended, set a server-side
> `KIE_API_KEY` or `FAL_API_KEY`. The poller then works normally — at the cost of the
> guarantee above. That choice is yours, and it is the whole reason the guarantee is
> real rather than marketing.

### A generation, step by step

```mermaid
sequenceDiagram
  participant U as You
  participant S as Keou
  participant P as Provider
  participant R as R2

  U->>S: upload photo + brief
  S->>R: store the source
  S->>P: generate (your key)
  P-->>S: task id
  Note over U,P: BYOK: your browser drives the polling —<br/>the key never leaves it
  loop until done
    U->>S: status? (with your key)
    S->>P: status?
  end
  P-->>S: result URL
  S->>R: copy result (provider URLs expire)
  S-->>U: durable URL
```

---

## Configuration

Copy `.env.example` to `.env`. Four values are mandatory in practice: the two
below, plus `ADMIN_EMAIL` and `ADMIN_PASSWORD` — without them the instance boots
with no account, and the sign-in page has nothing to let you through.

### Required

| Variable | Notes |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. Migrations run automatically at boot. |
| `JWT_SECRET` | Session signing secret, 16 chars minimum. Generate with `openssl rand -hex 32`. |

### Storage — required to upload

| Variable | Notes |
|---|---|
| `R2_ACCOUNT_ID` | Cloudflare account id |
| `R2_ACCESS_KEY` / `R2_SECRET_KEY` | R2 API token pair |
| `R2_BUCKET` | Bucket name (default `keou-uploads`) |
| `R2_PUBLIC_URL` | Public bucket domain, e.g. `https://assets.example.com` |

Skip these and the app boots, serves its pages, and refuses every upload with a 503
naming the missing variables. Nothing else in the studio works without an image going
in, so treat storage as required rather than recommended.

### Optional

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3401` | HTTP port |
| `EDITION` | `opensource` | Set by `index.js`; leave it alone |
| `DEFAULT_PROVIDER` | `kie` | `kie` or `fal` |
| `KIE_API_KEY` / `FAL_API_KEY` | — | A server-side fallback key. Leave unset for pure BYOK. |
| `ANTHROPIC_API_KEY` | — | Enables the assistant. Without it, the chat returns a clear error and nothing else breaks. |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | Model backing the assistant |
| `OPENAI_API_KEY` | — | Speech-to-text for voice input in the assistant |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | **Effectively required.** Seeds your account on an empty database — without them a self-hosted instance has no way to sign in. |
| `DATABASE_SSL` | — | Set to `0` to disable Postgres TLS. Needed with Docker against a local database. |
| `AGENCY_NAME` | `Keou` | Shown across the interface |
| `AGENCY_IMAGE_QUOTA` / `AGENCY_VIDEO_QUOTA` | `500` / `50` | Internal counters. There is no billing in this edition, but the defaults are NOT unlimited — raise them, or copy `.env.example`, which already does. |
| `JWT_EXPIRES` / `REFRESH_EXPIRES` | `15m` / `30d` | Token lifetimes |
| `DATABASE_SSL_STRICT` / `DATABASE_CA` | — | Certificate pinning for managed Postgres |
| `DISABLE_POLLER` | — | Set to `1` on replicas so only one instance polls |

---

## HTTP API

Every route is under `/api`. The generation routes sit directly on `/api` —
`/api/video`, not `/api/generate/video`. Authenticated routes take
`Authorization: Bearer <token>` from `POST /api/auth/login`, or a long-lived key from
`POST /api/keys` for scripts and MCP clients.

<details>
<summary><b>Generation</b> — mounted directly on <code>/api</code></summary>

| Method | Path | Does |
|---|---|---|
| `POST` | `/api/generate` | Image from a source photo + brief |
| `POST` | `/api/video` | Video from a still |
| `POST` | `/api/polish` | Retouch an existing render |
| `POST` | `/api/remix` | Re-imagine in a new direction |
| `POST` | `/api/adapt` | Recompose to other aspect ratios |
| `POST` | `/api/upscale` | Upscale a render |
| `GET` | `/api/status/:type/:taskId` | Poll a running job |
| `GET` | `/api/packs` | Available pack definitions |
| `POST` | `/api/pack` | Start an export pack |
| `GET` | `/api/pack/:packId/status` | Pack progress |
| `GET` | `/api/pack/:packId/zip` | Download the finished pack |
| `GET` | `/api/pending` | Your unfinished jobs (used to resume after a reload) |

Pass `generationId` when polling `/api/status` — without it the result is returned but
never persisted, and you end up holding a provider URL that expires.

</details>

<details>
<summary><b>Content & organisation</b></summary>

| Route | Does |
|---|---|
| `/api/upload` | Source images and video (field name: `image`) |
| `/api/download` | Signed download of a result |
| `/api/history` | Your library — list, tag, bulk-move, delete |
| `/api/projects` | Clients |
| `/api/campaigns` | Campaigns within a client |
| `/api/share` | Review links and client feedback |
| `/api/tools` | Voice-over, sound effects, image and video upscaling |

</details>

<details>
<summary><b>Account & team</b></summary>

| Route | Does |
|---|---|
| `/api/auth` | Register, login, refresh, logout, change password |
| `/api/profile` | Read and update your profile |
| `/api/keys` | Long-lived API keys for scripts and MCP (shown once, stored hashed) |
| `/api/team` | Invite members, roles, reset, remove |
| `/api/admin` | Instance settings, quotas, branding *(admin)* |
| `/api/analytics` | ROI, clients, velocity, campaigns, savings *(admin)* |
| `/api/activity` | Instance activity log *(admin)* |
| `/api/dashboard` | Dashboard aggregates |

</details>

<details>
<summary><b>Assistant</b> — <code>/api/jarvis</code></summary>

| Method | Path | Does |
|---|---|---|
| `POST` | `/api/jarvis/chat` | Streaming agent loop with the full toolset |
| `POST` | `/api/jarvis/stt` | Speech to text |
| `POST` | `/api/jarvis/tts` | Text to speech |

Requires `ANTHROPIC_API_KEY`, or a key saved in **Settings → API Keys**.
`/api/conversations` stores the chat history.

</details>

---

## Staying up to date

This repository is rebuilt from the Keou core on every change: engine improvements,
provider updates and security fixes land here as commits on `main`.

- **Railway with GitHub deploy** — enable auto-deploy on `main`, updates ship themselves.
- **Self-host** — `git pull && npm ci` and restart.

Issues and pull requests are welcome.

---

## Custom builds

Use this for free, forever, including commercially. MIT means you can run it for clients,
charge them, and keep the money. Attribution is appreciated, not required.

What we sell is the work of making it fit: **3D models, music, sound design, editing,
VFX** — and anything else your pipeline needs that the public build doesn't do yet.
Integration with the systems you already run (PIM, DAM, storefront, approval chain).
Deployment on your own infrastructure, under your own brand.

There is no price list. Tell us what you need, we scope it together, and you get a
fixed number in writing before anything starts. You own what we write, under the same
MIT terms.

[**Read the custom builds page →**](https://studio.kanaky.xyz/custom.html) ·
[kevyn@kanaky.xyz](mailto:kevyn@kanaky.xyz)

![Custom builds](public/docs-img/custom-builds.png)

---

## Licence

[MIT](LICENSE) © [Kanaky Tech](https://kanaky.xyz)

Run it, modify it, fork it, use it for client work, charge for that work, keep the
money. No licence fee, no revenue share, no attribution requirement.

**One thing you should know before deploying**, because we would rather say it than
have you find it: the build carries a provenance mark in three places — a `.origin`
dotfile, an `X-Origin-Sig` response header, and a keyword in `package.json`. All three
decode to the same string naming Kanaky Tech as the author. It phones nothing home, it
gates nothing, and you can delete all three: the header lives at the top of
`server.js`, the rest are plain files. We mention it because an undisclosed header is
the kind of thing that deserves to be found in the README, not in a diff.

<div align="center">
<sub>Built in Auckland, Aotearoa by <a href="https://www.linkedin.com/in/kevyn-wahuzue">Kevyn Wahuzue</a> · <a href="https://kanaky.xyz">kanaky.xyz</a></sub>
</div>

---

## Affiliate disclosure

The KIE.AI links in this README and on studio.kanaky.xyz carry our referral code.
KIE pays us a share of a referred user's first-month spend. It costs you nothing —
the price is identical — and Keou works with any provider key, however you obtained
it. Self-hosted deployments can point those links wherever they like; nothing in the
code depends on ours.
