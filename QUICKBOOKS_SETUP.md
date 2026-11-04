# QuickBooks setup

The Send to QuickBooks button stays hidden in the app until these steps are done.

## 1. Intuit Developer (10 min)

1. Sign in at developer.intuit.com with your Intuit login.
2. Create an app: QuickBooks Online and Payments. Tick the **Accounting** scope only.
3. Under **Development settings > Keys and credentials**, add this Redirect URI:
   `https://australia-southeast1-tjs---quote-template.cloudfunctions.net/qboCallback`
4. Copy the Client ID and Client Secret somewhere safe for step 3. Don't paste them into chat or the app.
5. Under **Sandbox**, add a sandbox company and pick **Australia**.

## 2. Firebase (5 min)

1. In the Firebase console for `tjs---quote-template`, upgrade to the **Blaze** plan.
2. In Google Cloud Billing, set a budget alert of about $5 a month.

## 3. Deploy (15 min, on your PC)

Needs Node from nodejs.org (LTS).

```
npm install -g firebase-tools
firebase login
git clone https://github.com/timseipolt-hub/TJS-Quotes.git
cd TJS-Quotes/functions
npm install
firebase functions:secrets:set QBO_CLIENT_ID
firebase functions:secrets:set QBO_CLIENT_SECRET
firebase deploy --only functions
```

When it asks for `QBO_ENV` and `APP_URL`, press Enter to accept the defaults (sandbox, and the app's GitHub Pages address).

## 4. Test in sandbox

Open the app, go to Jobs, click **Connect QuickBooks**, sign in and choose the sandbox company. Mark a job Done, click **→ QB**, check the lines and send.

## 5. Go live (after Intuit approves)

1. In Intuit Developer, complete **Production settings** (app details, privacy policy URL, terms of use URL, the same Redirect URI) and get production keys.
2. In QuickBooks: Settings > Account and settings > Sales > turn on **Custom transaction numbers**, so invoices use your TJS numbers.
3. Set the production keys and switch over:
   ```
   firebase functions:secrets:set QBO_CLIENT_ID
   firebase functions:secrets:set QBO_CLIENT_SECRET
   echo QBO_ENV=production > .env
   firebase deploy --only functions
   ```
4. In the app, Disconnect, then Connect QuickBooks again and pick the TJS company.

## How it works

- Nothing goes to QuickBooks automatically. Each done job gets a **→ QB** button (list view, and in the job form).
- The review screen bills hours worked x your hourly rate (excluding GST) under the Maintenance product, plus any materials from the quote. QuickBooks adds 10% GST. Your rate is remembered.
- Products: Maintenance, Materials, Engineering, Other. Existing ones in QuickBooks are used; missing ones are created.
- New customers are created; existing ones are matched by name.
- A job can only be sent once, and an invoice number already in QuickBooks is linked rather than duplicated.
- QuickBooks keys live in Firebase Secret Manager. Connection tokens are stored in Firestore `qboTokens`, which the web app never reads. If your Firestore rules have a catch all `allow read`, tighten them so only `users/{uid}` is readable.
