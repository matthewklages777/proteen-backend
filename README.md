# ProTeen Nation — Backend Server

Article mining, review queue, and admin dashboard for ProTeen Nation.

---

## What this does

- **Mines articles** from the web every few hours across all 8 ProTeen topic areas
- **Filters with Claude** — scores each article for quality and teen-appropriateness
- **Review queue** — team gets email with one-click Approve/Reject buttons
- **Admin dashboard** — full control panel at `/admin`
- **Public API** — website pulls approved articles automatically

---

## Setup (takes about 10 minutes)

### Step 1 — Install Node.js
Download and install from **nodejs.org** (choose the LTS version).
Verify: open Terminal and type `node --version` — you should see v18 or higher.

### Step 2 — Install dependencies
Open Terminal, navigate to this folder, and run:
```bash
npm install
```

### Step 3 — Configure your environment
Copy the example file and fill in your real values:
```bash
cp .env.example .env
```
Open `.env` in any text editor and fill in:
- `ANTHROPIC_API_KEY` — from console.anthropic.com
- `TAVILY_API_KEY` — from tavily.com (can add later)
- `EMAIL_FROM` / `EMAIL_PASSWORD` / `EMAIL_TO` — for review notifications
- `ADMIN_PASSWORD` — choose something strong

### Step 4 — Start the server
```bash
npm start
```
You should see the startup banner with the server URL.

### Step 5 — Open the admin dashboard
Go to **http://localhost:3001/admin** in your browser.
Enter your admin password and you're in.

### Step 6 — Run your first mining cycle
Click the **⚡ Mine Now** button in the top right.
Articles will appear in the review queue within 30–60 seconds.

---

## Deploying to Railway (free hosting, runs 24/7)

Railway lets you deploy this server for free so it runs automatically in the cloud.

1. Go to **railway.app** and sign up with GitHub
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Upload this folder to a GitHub repo first (github.com → New repository → upload files)
4. In Railway, click your project → **Variables** tab
5. Add all your `.env` variables one by one
6. Railway auto-deploys — you'll get a URL like `proteen-backend.railway.app`
7. Update your website's API calls to use that URL instead of `localhost:3001`

---

## Connecting to the website

Once deployed, the website fetches articles from:
```
https://your-railway-url.railway.app/api/articles?topic=sports
```

The ProTeen Nation website is already set up to call this API — you just need to update the `BACKEND_URL` variable in the website's JavaScript to point to your Railway URL.

---

## Switching to fully automatic mode

When you're ready to trust the system:
1. Open the Admin Dashboard → Settings
2. Change Posting Mode from "Review" to "Auto"
3. Set the confidence threshold (85 is recommended to start)
4. Articles scoring above that threshold post immediately; borderline ones still go to review

---

## Adding your Tavily API key later

1. Sign up at tavily.com
2. Copy your API key
3. Open `.env` and replace `YOUR_TAVILY_KEY_HERE` with your real key
4. Restart the server: `npm start`
5. Click "Mine Now" — real articles will now be found

Until Tavily is connected, the system runs in placeholder mode and won't fetch real articles, but everything else (admin panel, database, email) works fine.

---

## File structure

```
proteen-backend/
├── src/
│   ├── server.js      ← Main server & API routes
│   ├── miner.js       ← Article mining & Claude filtering
│   ├── database.js    ← JSON database (swap for MongoDB later)
│   ├── mailer.js      ← Review email notifications
│   └── topics.js      ← Topic definitions & search queries
├── public/
│   └── admin.html     ← Admin dashboard
├── data/
│   └── articles.json  ← Auto-created when first article is stored
├── .env.example       ← Copy to .env and fill in your keys
├── package.json
└── README.md
```

---

## Monthly cost estimate

| Service | Cost |
|---|---|
| Anthropic API (article filtering) | ~$5–15/month |
| Tavily (web search) | Free (1,000 searches/month) |
| Railway hosting | Free tier |
| **Total** | **~$5–15/month** |
