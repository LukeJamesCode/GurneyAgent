# Google OAuth Setup

Step-by-step guide for authorizing `gurney-everyday-assistant`. Calendar and Tasks are both covered by a single OAuth flow — you only need to do the Google Cloud Console steps once.

---

## What you need

- A Google account (the one whose Calendar and Tasks you want to access)
- Access to [Google Cloud Console](https://console.cloud.google.com/)

The extensions use a **Desktop application** OAuth client. No web server, no domain, no public redirect URI required.

---

## Step 1 — Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com/)
2. Click the project selector at the top → **New Project**
3. Name it anything (e.g. `gurney`) → **Create**
4. Make sure the new project is selected in the project selector

---

## Step 2 — Enable the APIs

In the left menu: **APIs & Services → Library**

Search for and enable each API you need:

- **Google Calendar API** — for calendar tools and event reminders
- **Tasks API** — for tasks tools

For each: click the API → **Enable**.

---

## Step 3 — Configure the OAuth consent screen

In the left menu: **APIs & Services → OAuth consent screen**

1. Choose **External** (even for personal use — Internal requires a Google Workspace account)
2. Fill in:
   - **App name**: `Gurney` (or anything)
   - **User support email**: your Google account email
   - **Developer contact email**: your Google account email
3. Click **Save and Continue**
4. On the **Scopes** page: click **Save and Continue** (you'll add scopes through the auth flow, not here)
5. On the **Test users** page: click **Add users** and add your own Google account email
6. Click **Save and Continue** → **Back to Dashboard**

The app stays in "Testing" mode — that's fine for personal use. It just means the refresh token expires after 7 days if you don't publish the app. **To avoid this**, publish the app (Step 3b) or use a service account (more complex, not covered here).

### Step 3b — Publish the app (optional, prevents token expiry)

On the OAuth consent screen dashboard: click **Publish App** → **Confirm**.

Once published, refresh tokens don't expire (unless revoked). The app is technically "public" but since it requires your own Google account credentials, no one else can use it.

---

## Step 4 — Create an OAuth client

In the left menu: **APIs & Services → Credentials**

1. Click **Create Credentials** → **OAuth client ID**
2. Application type: **Desktop app**
3. Name: `Gurney Desktop` (or anything)
4. Click **Create**
5. A dialog shows your **Client ID** and **Client Secret** — copy both or click **Download JSON**

Keep these safe — the client secret is a credential. It's stored in Gurney's `extension_settings` table (local SQLite, `~/.gurney/gurney.db`, mode `0600`).

---

## Step 5 — Run the auth flow

```sh
gurney auth gurney-everyday-assistant
```

The wizard asks for:

1. **Client ID** — paste from Step 4
2. **Client Secret** — paste from Step 4

Then it opens a local callback server on a random port and prints an authorization URL. Open the URL in your browser:

- Sign in with the Google account whose calendar and tasks you want to access
- Review the permissions (read/write access to Calendar and Tasks)
- Click **Allow**

The callback server captures the authorization code and exchanges it for a refresh token automatically. You don't need to copy anything. Both Calendar and Tasks access are requested in the same flow — one run of `gurney auth` covers both.

---

## Step 6 — Verify

After auth completes, test the integration:

```sh
# Start the bot if it isn't running
gurney start

# In Telegram, use a slash command:
# /events    (calendar)
# /todos     (tasks)
```

Or send a natural language message: "What's on my calendar today?"

---

## Re-authorizing

If your refresh token expires (this happens when the OAuth consent screen is in Testing mode and 7 days pass), run the auth flow again:

```sh
gurney auth gurney-everyday-assistant
```

The new token overwrites the old one in `extension_settings`.

To check the stored credentials:

```sh
gurney config
# → navigate to gurney-everyday-assistant
# → google_client_id and google_refresh_token should be present (secrets are masked)
```

---

## Troubleshooting

### "Access blocked: This app's request is invalid" in the browser

The redirect URI doesn't match. Gurney's auth flow uses `http://localhost:<random-port>`. Make sure:

- The OAuth client type is **Desktop app** (not Web application)
- Desktop app clients allow any `localhost` redirect by default — if you see this error, you may have accidentally created a Web application client

### "Error 400: redirect_uri_mismatch"

Same issue as above — wrong client type. Create a new credential with type **Desktop app**.

### Token expired after 7 days

Your OAuth consent screen is in Testing mode. Either:

- Publish the app (Step 3b above), or
- Re-run `gurney auth` every 7 days (annoying), or
- Add your Google account as a Test User (which resets the 7-day clock)

### "insufficient_scope" when using a command

The refresh token was issued before you added the scope. Re-run `gurney auth` for the affected extension to get a new token with the correct scope.

### Calendar events from the wrong calendar

The extension defaults to the `primary` calendar. Change the `calendar_id` setting:

```sh
gurney config
# → gurney-everyday-assistant → calendar_id
```

To find calendar IDs: go to [calendar.google.com](https://calendar.google.com) → Settings → the calendar you want → **Calendar ID** (looks like `abc123@group.calendar.google.com`).
