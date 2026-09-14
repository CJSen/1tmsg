[English](README.en.md) · [简体中文](README.md)

# 1tmsg · Burn-after-reading secret messages

Send a password, API key, internal link, or a piece of text to someone — **they read it once, and the content on the server is deleted immediately.**

The content is encrypted in your browser; the server only stores an unreadable ciphertext: no account, no server to maintain, no database to install, no monthly fee.

<p align="center">
  <img src="docs/static/create.png" width="560" alt="1tmsg create page">
</p>

> 💡 **Deploy in 5 minutes, runs within the free tier.** You only need a Cloudflare account; just copy the commands below.

---

## What it does in 30 seconds

| | |
|---|---|
| **Good for** | Sending one-time passwords, API keys, internal addresses, temporary credentials, or text you don't want lingering in chat history; with image support enabled, screenshots too |
| **Not good for** | Long-term archiving, multi-person collaboration, or scenarios requiring audit trails |
| **How privacy is guaranteed** | The decryption key sits in the link (after the `#`); the browser handles encryption/decryption; the server has neither the key nor the plaintext |
| **How it's destroyed** | Default "burn after reading": opened once, the ciphertext on the server is deleted immediately. You can also set an expiration (up to 7 days), view count (1–100), and access password |

Simply put: **What you type in the box, even Cloudflare cannot see.**

---

<details>
<summary><b>UI Preview</b> · Click to expand 4 screenshots</summary>

<br>

**Create page** —— write content, choose destruction method, generate link in one click

<img src="docs/static/create.png" width="600" alt="Create page">

**After successful creation** —— the part after `#` in the link is the decryption key; the server never receives it

<img src="docs/static/sent.png" width="600" alt="Creation successful">

**When the other party opens it** —— decrypted locally in the browser, destroyed after viewing

<img src="docs/static/view.png" width="600" alt="View page">

**Mobile** —— works on narrow screens too

<img src="docs/static/mobile.png" width="300" alt="Mobile">

</details>

---

## Pick a version first: do you need image support

**This is the only decision point in the entire deployment: which template you pick is which version you get.**

| | Text only (default) | With images |
|---|---|---|
| Template file | `wrangler.jsonc.example` | `wrangler.jsonc.example.r2` |
| What you can send | Text, Markdown | Text, Markdown, **images** (single ≤ 100 MB) |
| R2 required | No | Yes —— R2 requires a payment method to enable |

The two templates differ only by one `r2_buckets` declaration — **having this block means the image-capable version.**

Image ciphertext is stored in Cloudflare R2 object storage, and enabling R2 requires binding a payment method. Many people don't want to bind a card, so **the default uses the text-only one, never touching R2 throughout the entire process.**

"Whether `r2_buckets` is in the config" simultaneously determines three things — whether the R2 binding is declared, whether the frontend builds an image entry, and whether the server accepts image attachment requests — so there's no mismatch of "button in the UI but backend rejects it."

---

## CLI deploy / one-click deploy: about 5 minutes

### Preparation

| Need | Notes |
|---|---|
| Cloudflare account (required) | Free sign-up: https://dash.cloudflare.com/sign-up |
| Git (CLI deploy) | For cloning the repo; if not installed, download from https://git-scm.com |
| Node.js 22+ (CLI deploy) | Run `node -v` in terminal; if not, download LTS from https://nodejs.org |

### Step 1 · Pick a version and deploy (choose one of two tabs)

The two tabs below are each a **complete path**; pick one and follow it through. **"Text only" is expanded by default**; switch to the "With images" tab if you want to send images — it adds two extra steps (enabling R2 and creating a bucket). See "Pick a version" above for the difference.

<details>
<summary>🟦 Text only (default)</summary>

#### One-click deploy:
 [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/CJSen/1tmsg)

 > The one-click deploy is for trial only and won't receive future updates. It's recommended to use the web deploy or CLI deploy, so you can sync upstream code and update immediately.

#### Web deploy:

```md
 Fork this repo to your own repo.

 Go to the [Cloudflare Workers](https://deploy.workers.cloudflare.com/) web console,

 connect your GitHub account, select the forked repo to deploy — no config changes needed, just deploy directly.
```

#### CLI deploy:

**① Clone the repo, copy the config template (customize if needed)**

```bash
git clone https://github.com/<your-account>/1tmsg.git
cd 1tmsg
cp wrangler.jsonc.example wrangler.jsonc
```

**② Install dependencies**

```bash
npm install
```

**③ Log in to Cloudflare**

```bash
npx wrangler login
```

Opens the browser automatically; click **Allow** to authorize.

**④ Deploy**

```bash
npm run deploy
```

</details>

<details>
<summary>🟨 With images (needs R2, needs card binding)</summary>

#### One-click deploy
> One-click deploy not yet supported. It's recommended to fork to your own repo, then link your repo manually on [Cloudflare Workers](https://deploy.workers.cloudflare.com/) to deploy, so you can sync upstream code and update immediately.
```bash
cp wrangler.jsonc.example wrangler.jsonc
```
> ⚠️ Image version: the button auto-creates the R2 bucket, but **your account must have R2 enabled (payment method bound)** first, otherwise the bucket-creation step fails. The text-only version has zero barriers.

#### CLI deploy:

**① Clone the repo, copy the config template**

```bash
git clone https://github.com/<your-account>/1tmsg.git
cd 1tmsg
cp wrangler.jsonc.example wrangler.jsonc
```

**② Enable R2 and create a bucket**

Log in to the Cloudflare console, click **R2** on the left → follow the prompts to enable (free tier 10 GB/month, but a payment method is required to enable). Then create a bucket and add a 7-day auto-cleanup fallback:

```bash
npx wrangler r2 bucket create 1tmsg-blobs
npx wrangler r2 bucket lifecycle add 1tmsg-blobs expire-old --expire-days 7
```

> ⚠️ Do not make the bucket publicly readable (don't bind a custom domain, don't enable the r2.dev public domain), otherwise "burn after reading" is broken.

**③ Install dependencies**

```bash
npm install
```

**④ Log in to Cloudflare**

```bash
npx wrangler login
```

Opens the browser automatically; click **Allow** to authorize.

**⑤ Deploy**

```bash
npm run deploy
```

</details>

### After completion

The terminal will print your access address, like:

```
https://1tmsg.<your-account>.workers.dev
```

Open it and you're using it. **This address is your service homepage**; share it with whoever needs to use it.

It's recommended to configure a custom domain in the cf workers console for easier memorization and access.

---

## Adjust after deployment

| What you want to do | How |
|---|---|
| **Switch site default language** | Edit `vars.DEFAULT_LOCALE` in `wrangler.jsonc` (`"zh"` / `"en"`, default `zh`), then `npm run deploy` again. The UI is bilingual (Chinese/English); **no automatic browser-language following** — the site language is this value, and visitors can manually switch via the `EN / 中文` button in the top-right (the choice is remembered) |
| **Enable / disable image support** | Add / remove the `r2_buckets` block in `wrangler.jsonc` (enable R2 and create a bucket first before adding), then `npm run deploy`; you can also just swap the template copy |
| **Use your own domain** | Edit `wrangler.jsonc`, uncomment the `routes` line and replace it with your domain, then `npm run deploy`. The domain must be hosted on Cloudflare; certificate and DNS records are created automatically — **do not** manually add A/CNAME |
| **Change Worker name** | Change `name` in `wrangler.jsonc`. If image support is on, the bucket name in the create command must also stay consistent (or create a different bucket name and sync `bucket_name`) |
| **Disable workers.dev fallback address** | Remove the `workers_dev` line from `wrangler.jsonc`, keeping only the custom domain |
| **Adjust per-message / per-image limits** | Edit the `vars` in `wrangler.jsonc` (`MAX_MESSAGE_BYTES`, `MAX_ATTACHMENT_BYTES`, `RATE_LIMIT_MAX_CREATES`) then redeploy. The latter two only matter in the image version |
| **Update version** | `git pull && npm run deploy` to overwrite-upgrade. Local changes like toggles and domains stay in `wrangler.jsonc` and are unaffected |

`wrangler.jsonc` is in `.gitignore` (it carries your real domain and bucket name), so changes stay local.

---

## How to use it

1. **Open your service address**, fill in content (Markdown supported; the image version also lets you paste or drag in images).
2. As needed, choose: **burn after reading** (default on) / expiration time / view count / access password, then click **Create and copy link**.
3. **Send the link to the other party**. They open it once, the content is decrypted and displayed in the browser, then the ciphertext on the server is deleted.

> A forwarded link cannot be recalled — anyone who gets the link can view it. Send it through a trusted channel.

---

## Default limits

| Item | Value |
|---|---|
| Single image ※ | ≤ 100 MB, up to 8 images |
| Total images ※ | ≤ 200 MB / message |
| Text content | ≤ 10 MB |
| Expiration time | 1 minute – 7 days, default 1 hour |
| View count | 1 – 100, default 5 (available when burn-after-reading is off) |
| Note | ≤ 120 chars |
| Access password | ≥ 6 chars, 10 consecutive wrong attempts destroys the message |
| Creation rate | 30 messages / IP / minute |

> ※ Only present in the image version (`wrangler.jsonc.example.r2`); the text-only version doesn't use these.

---

## About security

- **Plaintext only exists in your browser.** Encryption and decryption are completed locally; the server only stores and retrieves ciphertext.
- **The decryption key is placed after the `#` in the link.** The browser spec guarantees this part is never sent to the server, and it's immediately wiped from the address bar after the page opens.
- **A database leak can't reveal content.** An attacker only gets metadata like `ciphertext + expiration + view count`.
- **Zero external dependencies on the page.** No CDN, analytics scripts, external fonts, or images are loaded; all frontend code comes from this project itself.
- **No inline scripts on the service.** Combined with strict CSP and security response headers, third parties can hardly inject anything into the decryption page.
- **The only local storage is language preference.** Only clicking the `EN / 中文` button in the top-right stores a `"zh"` or `"en"` in the browser, containing no message, key, or content; automatic browser-language following writes nothing.

For the complete security model, key derivation method, why images go through object storage separately, and all known trade-offs, see **[docs/spec.md](docs/spec.md)**.

---

## FAQ

**Q: Does it cost money?**
Free plan is enough: Workers 100k requests/day, Durable Objects 5 GB storage; if image support is enabled, add R2's 10 GB/month (downloads not billed). Usage stays within free tiers, **no automatic charges**, and it errors out instead of generating a bill when exceeded. The text-only version doesn't even need R2, so no card binding.

**Q: Can the server see what I wrote?**
No. The server only stores ciphertext and expiration. But remember: **anyone holding the full link can decrypt it** — that's the purpose of this tool, and it also means a forwarded link can't be recalled.

**Q: I sent the link to the wrong person, what now?**
No one can remotely recall an already-sent link. A viable approach: if the message has a password, the recipient can't open it without it; otherwise wait for it to expire (setting a short expiration is a good habit).

**Q: `wrangler login` stuck or failing?**
Mostly a network issue. Try enabling a proxy and retry, or switch to API Token login (Cloudflare console → My Profile → API Tokens).

**Q: I don't want to bind a card, can I use it?**
Yes, and that's the default path — the text-only version needs no R2 throughout, so no payment method binding. Follow the three steps `npm install && npx wrangler login && npm run deploy`.

**Q: Deployment asks to enable R2, requiring card binding?**
It means `wrangler.jsonc` declares `r2_buckets` (i.e., you used the image template). Don't want to bind a card? Switch to text-only: remove that `r2_buckets` block, or re-run `cp wrangler.jsonc.example wrangler.jsonc`, then `npm run deploy`.

**Q: Deployed text-only first, want to add images later?**
Complete R2 enabling and bucket creation as above, copy the `r2_buckets` block from `wrangler.jsonc.example.r2` into `wrangler.jsonc` (or just overwrite with this template), then `npm run deploy`. Going the other way (from image back to text-only) means **previously sent image messages will have broken images** — the body and note remain viewable, but the image shows a missing placeholder.

**Q: Deploy error says bucket not found?**
The bucket name at creation differs from `bucket_name` in `wrangler.jsonc`. Change both to the same name (default `1tmsg-blobs`).

**Q: Deployment succeeded but page won't open?**
Wait about 30 seconds first (a new Worker needs a moment on first launch); if still not opening, confirm `workers_dev` in `wrangler.jsonc` wasn't removed, and that you're using the address printed by the terminal.

**Q: Local debug creating the 30th message gets 429?**
The local environment shares one IP identifier across all requests, hitting the "30 per minute" creation rate limit. Online buckets by real IP, so this doesn't happen.

**Q: Why do images need separate R2? Can't the database handle it?**
Images are large binaries; stuffing them into the database makes fetching a piece of text also download all images. This project stores **text ciphertext in the database, image ciphertext in object storage**; both are one-time access, security unaffected. Don't want R2? Deploy the text-only version; the loss is only images.

---

## Local development (optional)

```bash
npm run dev          # build frontend and start local server (http://localhost:8787)
npm run typecheck    # TypeScript type check
npm run build        # only build frontend assets
```

`dev` / `build` / `deploy` rebuild the frontend based on the current `wrangler.jsonc`, so what you see locally is what gets deployed. To preview the text-only version locally, swap the config to the text-only template and start:

```bash
cp wrangler.jsonc.example wrangler.jsonc && npm run dev
```

Local debug uses wrangler's local mock storage, **having `r2_buckets` doesn't require actually enabling R2**, no card binding involved.

---

## Technical details

If you care about how it works — how keys are derived, why an extra `verifier` is stored, how images avoid leaking the recipient's IP, how the `readToken` grace period is designed — see:

- **[docs/spec.md](docs/spec.md)** —— full design spec

Tech stack: TypeScript + Web Crypto, Cloudflare Workers + Durable Objects (SQLite); with image support enabled, add a private R2 bucket. No VPS, MySQL, or Redis needed.

---

## License

[MIT License](LICENSE) © 2026 chjs
