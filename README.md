# SmartSpend - AI Expense Tracker (Groq + Firebase)

A web app to track your expenses with **AI powered by Groq**, deployed on **Firebase** (Hosting + Cloud Functions).

## What the app can do
- **Add with AI:** type *"lunch 450 and uber 300 yesterday"*. Groq understands several items, amounts, dates and categories. You can check and change the result before it is saved.
- **Auto category:** leave the category on "Auto" when adding manually and the AI chooses it.
- **AI insights:** short advice about the selected month (biggest category, change vs last month, budget, a saving tip).
- **Ask about your spending:** a chat that answers questions such as "How much did I spend on transport?"
- **Dashboard:** totals, monthly budget bar, doughnut chart by category, last 6 months chart, search and filters, CSV export.
- **Offline mode:** if the AI service is not available, quick-add and categories still work with simple rules (no AI).

## How it works
```
 Browser (public/)  ──►  Firebase Hosting  ──/api/chat──►  Cloud Function "chat"  ──►  Groq API
   HTML + JS + CSS         serves the page      (rewrite)     (functions/index.js)       (Llama model)
        │                                                          │
   expenses saved in                                     GROQ_API_KEY stored in
   the browser (localStorage)                            Google Secret Manager
```
**Why a Cloud Function?** Anything inside a web page can be read by visitors. If the Groq key were in the JavaScript, anybody could steal it.
So the browser only talks to *our own* `/api/chat`, and the function adds the secret key on the server.

## Project structure
| Path | Purpose |
|---|---|
| `public/index.html`, `css/style.css` | the page |
| `public/js/app.js` | connects the page with data, AI and charts |
| `public/js/ai.js` | prompts for Groq, validation of AI answers, fallback to rules |
| `public/js/fallback.js` | offline rules (category keywords, simple text parser) |
| `public/js/store.js` | saving expenses and settings in the browser |
| `public/js/utils.js`, `charts.js` | helpers (dates, totals, CSV) and SVG charts |
| `functions/index.js` | Firebase function (secret key, region, limits) |
| `functions/groqProxy.js` | the proxy logic: validation, rate limit, call to Groq, safe error messages |
| `firebase.json`, `.firebaserc` | Firebase Hosting + Functions configuration |
| `dev-server.js` | local test server (same behaviour as Firebase) |
| `tests/`, `functions/test/` | automatic tests |

## 1. Try it on your computer (no Firebase needed)
Install Node.js 18 or newer, open a terminal in the project folder and run:
```bash
node dev-server.js
```
Open http://localhost:5000. Without a key the app runs in **offline mode**. To test the AI, get a free key at https://console.groq.com/keys and start the server like this:
```bash
# Windows PowerShell
$env:GROQ_API_KEY="gsk_your_key"; node dev-server.js
# Mac / Linux
GROQ_API_KEY=gsk_your_key node dev-server.js
```
The pill at the top right shows **"AI on"** when Groq is connected.

## 2. Deploy on Firebase
1. Go to https://console.firebase.google.com and **create a project**. Note its **Project ID**.
2. **Upgrade the project to the Blaze (pay-as-you-go) plan.** Cloud Functions and Secret Manager need it. It has a free monthly quota, but a payment card is required; create a **budget alert** in Google Cloud for safety.
   *(No card? You can still deploy only the website with `firebase deploy --only hosting`. The app then works in offline mode without AI. If the CLI warns that function `chat` was not found, that is expected.)*
3. Install the Firebase tools and log in:
   ```bash
   npm install -g firebase-tools
   firebase login
   ```
4. Put your Project ID in `.firebaserc` (replace `YOUR-FIREBASE-PROJECT-ID`), or run `firebase use --add`.
5. Install the function's packages:
   ```bash
   cd functions
   npm install
   cd ..
   ```
6. Store your Groq key as a secret (paste it when asked; it is never written in any file):
   ```bash
   firebase functions:secrets:set GROQ_API_KEY
   ```
7. Deploy everything:
   ```bash
   firebase deploy
   ```
   The first time, the CLI may ask to enable some Google APIs (Cloud Functions, Cloud Build, Artifact Registry, Secret Manager). Answer yes.
8. Open the **Hosting URL** printed at the end: `https://YOUR-PROJECT-ID.web.app`. The pill must show **"AI on"**.

Update later: change the code and run `firebase deploy` again. See function logs with `firebase functions:log`.

### Change the Groq model
The default is `llama-3.3-70b-versatile`. If Groq retires a model you will see "model may be unavailable". Choose a current model from https://console.groq.com/docs/models and redeploy with it:
set `GROQ_MODEL` (the function asks for it at deploy time, or edit the default in `functions/index.js`).

## Tests
```bash
node --test            # 24 unit tests: proxy function + browser logic (Node 22 recommended)
python tests/e2e.py    # real browser test with a FAKE Groq server (needs: pip install playwright && playwright install chromium)
```
The tests never use your real key.

## Security notes
- The Groq key exists only in Secret Manager; the browser never sees it.
- The function accepts only small, validated requests, always uses the model chosen on the server, limits answer length, hides upstream error details, and limits requests per visitor (best effort).
- `maxInstances: 5` limits cost if someone abuses the public endpoint. For a real product add **Firebase Authentication / App Check**.
- All user and AI text is escaped before it is shown (protects against HTML injection); `firebase.json` adds a Content-Security-Policy.
- CSV export neutralises cells that start with `=`, `+`, `-` or `@`.

## Limitations and ideas
- Expenses are saved **in the browser only** (per device). Next step: Firebase Authentication + Firestore to sync between devices.
- AI can make mistakes. The app lets you review AI-added expenses first and tells you when AI was or was not used.
- Ideas: recurring expenses, receipt photo scanning, multiple currencies.

## Troubleshooting
| Problem | What to do |
|---|---|
| Pill says "Offline mode" on the deployed site | The function is not deployed or the secret is missing: run steps 5-7 again and check `firebase functions:log`. |
| `firebase deploy` asks to upgrade the plan | Functions need the Blaze plan (step 2). |
| "model may be unavailable" | Change `GROQ_MODEL` to a current model. |
| "AI rate limit reached" | Wait a minute (Groq free plan has limits). |
| Changes not visible after deploy | Hard refresh (Ctrl+F5). |

## Possible viva questions
- **Why not call Groq directly from JavaScript?** The key would be visible to everyone; a server-side function keeps it secret.
- **What is a Cloud Function / Firebase Hosting?** Hosting serves static files from a CDN; a Cloud Function is code that runs on demand on Google's servers. A Hosting *rewrite* sends `/api/chat` to the function.
- **How does the AI turn text into an expense?** A prompt tells Groq to return only JSON with amount, description, category and date. The app validates every field and lets the user confirm.
- **What is JSON mode?** An option that makes the model answer with valid JSON, so the program can read it.
- **What if the AI is down?** The app falls back to keyword rules and says so.
- **Where is the data stored?** In the browser's localStorage. Firestore would be the cloud option.
