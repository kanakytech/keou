# Contributing

## The short version

Fork, branch, make it work, open a pull request. `npm test` has to pass. That is the
whole process.

## Before you start something large

Open an issue first. Not for permission — to avoid the case where two people build the
same thing, or where you spend a weekend on something that does not fit where the
project is going. A paragraph is enough.

## Running it locally

```bash
npm ci
cp .env.example .env     # DATABASE_URL, JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
npm start
```

You need PostgreSQL. Migrations run at boot — you never create tables by hand. You also
need a provider key ([KIE.AI](https://kie.ai?ref=ec0e98ef53c18d6f13f05629a9ffd793) or [Fal.ai](https://fal.ai)), which you
paste into the studio; the server never needs one.

```bash
npm test          # syntax check + smoke test (module loading, runtime sanity)
```

## How the code is laid out

`server.js` mounts everything. `src/routes/` is one file per API surface.
`src/lib/keou-actions.js` is the generation engine. `src/lib/providers/` holds the
KIE.AI and Fal.ai adapters behind one interface — a third provider goes there and
nowhere else. `public/` is the whole frontend: plain HTML and vanilla JavaScript, no
build step, no framework.

## What gets merged quickly

Bug fixes with a reproduction. New provider adapters. Format presets in
`src/lib/packs.js` — it is a plain list, adding to it is a two-line change.
Documentation that corrects something wrong.

## What needs a conversation first

Anything that adds a build step to the frontend. Anything that makes a provider key
leave the browser. New dependencies — the tree is deliberately small.

## Style

Match the file you are editing. Comments explain *why*, not *what*; the code already
says what. Commit messages describe the change and its reason, in plain prose.

## Licence

Contributions ship under [MIT](LICENSE), the same as the rest.
