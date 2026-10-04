# Pautang Notebook

A phone-friendly utang (credit) ledger for a sari-sari store.

- Add customers and record **utang** as item lines (product, qty, price) that total automatically.
- Record **bayad** payments, full or partial hulog.
- See the total **frozen money** (all unpaid utang) at the top, plus each customer's running balance.
- Records are saved online in a Postgres database, so a lost or broken phone loses nothing and every device you log in on shows the same list.
- Works offline: changes made without internet wait on the phone and are saved as soon as it reconnects.
- Installable: open the site on your phone and choose **Add to Home screen**.

## How it's built

- `server.js`: a small Express server. It serves the app from `public/`, checks the store password, and saves customers and entries to Postgres. It creates its tables on startup.
- `public/index.html`: the whole app (HTML, CSS and JS, no build step).
- `public/sw.js`: service worker that keeps the app opening offline. Bump `CACHE` when app files change.

## Deploying (Render + Neon)

1. In [Neon](https://neon.tech), create a project and copy its connection string (`postgresql://...?sslmode=require`).
2. In [Render](https://render.com), choose **New → Blueprint** and pick this repo. Render reads `render.yaml`.
3. When asked, fill in:
   - `DATABASE_URL`: the Neon connection string
   - `APP_PASSWORD`: the password you'll type to log in

   `SESSION_SECRET` is generated for you.
4. Deploy. The app is at the `onrender.com` link Render shows.

Render's free plan sleeps after about 15 minutes without visits, so the first open after a break can take up to a minute.

## Running locally

```sh
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/pautang APP_PASSWORD=secret SESSION_SECRET=anything npm start
```

Then open http://localhost:3000.
