# Study Notebook

One notepad per tutor (text, links and files), stored in a Neon PostgreSQL database.

**Live site:** https://tutor-notes.onrender.com (opens straight to the notebook, no sign-in)

- `server.js`: the web server. It keeps the database password private.
- `public/index.html`: the notebook page.
- `db/schema.sql`: the database tables.
- `.env`: your private settings. Never share it or upload it to GitHub.

## Run it on your computer

```bash
npm install
npm start
```

Then open http://localhost:3000.

## Settings (`.env`)

| Setting | What it is |
|---|---|
| `DATABASE_URL` | The Neon connection string (Neon: **Dashboard → Connect**) |
| `REQUIRE_LOGIN` | Leave off (the default) to open the notebook without a password. Set to `true` to ask for an access code |
| `APP_PASSWORD` | The access code, used only when `REQUIRE_LOGIN=true` |
| `SESSION_SECRET` | Long random text that signs the login cookie, used only when `REQUIRE_LOGIN=true` |

After you reset the Neon password, paste the new connection string into `DATABASE_URL` and restart.

## Put it online (Render)

1. Upload this folder to a **private** GitHub repository. `.env` and `node_modules` are skipped automatically.
2. On render.com, choose **New → Blueprint** and pick the repository. Render reads `render.yaml`.
3. When Render asks, paste the Neon connection string into `DATABASE_URL`. `SESSION_SECRET` is made up automatically.
4. Click **Deploy**. Render gives you an address like `https://study-notebook.onrender.com` to share with your tutors.

On Render's free plan, the site sleeps after 15 minutes with no visitors, and the next visit takes about a minute to wake it up. The paid plan stays awake.

## New database

To start fresh in another Neon project (for example one in the London region), put its connection string in `.env` and run:

```bash
npm run setup-db
```
