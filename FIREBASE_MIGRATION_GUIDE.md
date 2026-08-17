# PRC Region III Queue — Migrating to Firebase

## Why this is faster

Your Sheets version polled `/exec` every 2 seconds from three separate screens — each poll is a full round trip through Apps Script to a Sheet and back. Firestore's `onSnapshot` listeners push changes to every connected screen the instant something changes, with no polling at all. Staff calling "Next" now updates the public display board effectively instantly instead of up to 2 seconds later, and you stop burning Apps Script's execution quota entirely.

## What changed structurally

- **No more Apps Script.** `Code.gs` is retired — Firestore is the backend now, called directly from each HTML file.
- **No more Sheets.** `Queue`, `Counters`, `TransactionsLog`, `DailySummary`, `ArchivedTransactions` are replaced by Firestore collections (below).
- **"Reset" no longer deletes anything.** Tickets are stamped with a `cycle` number; Reset just advances the active cycle, so old tickets vanish from every "current" view instantly but stay in Firestore forever as automatic history. No more archive sheet needed.
- **Admin PIN (Reset / Add Counter) is enforced by Firestore Security Rules**, not by a server, since you're not using Cloud Functions. See the "Security, honestly" section below — please read it, it's a real trade-off.

## Step 1 — Create the Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project**. Name it something like `prc-region3-queue`. You can skip Google Analytics.
2. In the left sidebar: **Build → Firestore Database → Create database**. Choose **production mode** (we're supplying our own rules) and pick a region close to you (e.g. `asia-southeast1`).
3. **Build → Hosting → Get started** — you'll deploy the HTML files here later. Firebase Hosting is free at your scale and gives you HTTPS automatically.
4. **⚙ Project settings → Your apps → Web (`</>`)** → register an app (any nickname). Copy the `firebaseConfig` object it shows you.

## Step 2 — Fill in your config

Open `firebase-config.js` and paste your copied config into the `firebaseConfig` object. Every other file (`queue-core.js`, and the three HTML pages) imports from this one file — don't duplicate the config elsewhere.

## Step 3 — Publish rules, then seed, then lock down

The seed tool needs to write `config/admin` and `systemState/current` once — but the rules file intentionally makes both of those permanently unwritable from the client (`allow write: if false`), so you must seed *before* publishing the final rules:

1. In Firestore Rules (console → Firestore Database → Rules), temporarily paste this looser version and **Publish**:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} { allow read, write: if true; }
     }
   }
   ```
2. Open `seed-firestore.html` in a browser (locally is fine — open the file directly, or run any static server). Set your admin PIN and counter names, click **Seed Firestore**. Confirm in the console under Firestore Database → Data that `config/admin`, `systemState/current`, and your `counters/*` docs exist.
3. Go back to Firestore Rules, replace the loose version with the real contents of `firestore.rules`, and **Publish** again.
4. **Test immediately**: try Reset and Add Counter from the staff panel with the wrong PIN first (should fail), then the right PIN (should succeed). I could not run these rules against a live project myself, so this test matters — the Rules Playground in the console (Rules tab → "Simulator") is the fastest way to check a single case if something doesn't behave as expected.

## Step 4 — Data model reference

| Collection | Purpose |
|---|---|
| `counters/{counterId}` | One doc per physical counter — status, current ticket, service, transactionType |
| `queue/{autoId}` | One doc per ticket ever issued — status, service, transactionType, cycle, timestamps. Never deleted — this is now your full history/reporting source |
| `serviceCounters/{code_cycle}` | Atomic per-service, per-cycle ticket numbering |
| `dailySummary/{yyyy-mm-dd}` | Aggregate counts per counter/service, incremented on Mark Done |
| `systemState/current` | Holds `activeCycle` — advancing this is what "Reset" means now |
| `config/admin` | Holds the admin PIN, never readable by any client |
| `resetRequests/`, `counterRequests/` | Write-only PIN-verification records (see below); safe to ignore in the console, you'll never need to read them |
| `adminLogs/{autoId}` | Same audit trail as your old AdminLogs sheet |

## Step 5 — Deploy the front-end files

Put `firebase-config.js`, `queue-core.js`, and the three HTML files in one folder and deploy with Firebase Hosting:

```bash
npm install -g firebase-tools
firebase login
firebase init hosting   # point the public directory at this folder
firebase deploy
```

You'll get three URLs like `https://your-project.web.app/ticket-kiosk.html`, `/staff-panel.html`, `/display-board.html` — use those wherever you previously linked the Apps Script HTML pages.

`seed-firestore.html` should **not** be deployed alongside them — run it once locally, then leave it out of the `firebase deploy`.

## Security, honestly

Your original Apps Script checked the admin PIN **on Google's server** — a client literally could not reset the queue without it, full stop. Pure client-side Firestore calls can't replicate that without Cloud Functions or Firebase Auth, which you've chosen to skip for now.

What I built instead: Reset and Add Counter each require first writing to a write-only collection (`resetRequests` / `counterRequests`) that only accepts the write if the submitted PIN matches `config/admin` — checked by the security rules themselves, not by your JavaScript. A wrong PIN makes that write fail, and the follow-up action (advancing the cycle, creating the counter) is only allowed if a valid request document already exists. This is real enforcement, at the database layer, not just a PIN box in the UI — meaningfully better than "the PIN is only checked in JavaScript."

It is **not** as strong as a real backend: everyday actions (Call Next, Recall, Mark Done) still have no PIN protection at all, same as your original system. And Firestore rules, unlike Apps Script, can't be 100% guaranteed correct without testing — please actually try the wrong-PIN case in Step 3 before this goes live for real transactions. If you ever want the stronger guarantee later, the natural upgrade path is Firebase Authentication (staff sign in with real accounts) plus rules keyed to `request.auth`, which doesn't require Cloud Functions either — happy to help with that when you're ready.

## Step 6 — Test end to end

1. Kiosk: generate a Priority Transaction ticket, pick "Renewal."
2. Staff panel: it should appear in **Priority Watch** immediately (no refresh).
3. Call it — "Currently Serving" updates instantly, badge shows "⭐ Priority — Renewal."
4. Display board: same info shows up immediately, no 2-second delay.
5. Reset with the wrong PIN → should fail. Right PIN → cycle advances, all counters go Idle, and a fresh kiosk ticket for the same service starts back at 001.

## What I could not verify

I don't have a live Firebase project to run this against, so I wasn't able to execute the rules, the transactions, or the composite queries before handing this to you. Two things worth double-checking once you're live:

- The first time `callNext` or the Priority Watch list runs, Firestore may show a console error with a link to auto-create a required composite index (for the `status` + `cycle` + `service` + `createdAt` query). Click it — it takes about a minute to build — then retry.
- Spot-check a `dailySummary/{date}` document in the console after a couple of "Mark Done" actions to confirm the per-counter and per-service counts look right.
