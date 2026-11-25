# Quote Assistant setup

The Quote Assistant is a chat panel in the app (the **✦ Quote Assistant** button, bottom right, and **Describe a job to the Quote Assistant** on the welcome screen). Describe a job in plain English, add site photos if you like, and it fills in the quote form: client and site details, services, line items, inclusions, exclusions, notes and pricing basis. Then ask for changes ("make it Cost Plus", "drop item C", "tidy the descriptions").

It runs on Claude (Anthropic) through a Firebase function, the same way QuickBooks does. It needs the Blaze plan and the deploy steps from `QUICKBOOKS_SETUP.md`.

## 1. Anthropic API key (5 min)

1. Sign in at console.anthropic.com, add a payment method, and set a monthly spend limit (Settings > Limits). $20 is plenty to start.
2. Create an API key (Settings > API keys). Don't paste it into chat or the app.

## 2. Deploy (on your PC)

```
cd TJS-Quotes/functions
git pull
npm install
firebase functions:secrets:set ANTHROPIC_API_KEY
firebase deploy --only functions
```

Paste the key when asked. Until this is deployed, the panel shows "The Quote Assistant is not deployed yet".

## How it works

- **Prices come from your history.** Before pricing, it searches your saved quotes for similar work and uses your unit costs (accepted quotes count most). Where you have no history it estimates from typical Victorian trade rates and tells you which prices to check.
- **It writes into the form, nothing else.** Changes are applied to the quote you have open and auto-saved as a draft, like moving between sections. It never sends, saves as a final quote, or emails anything. Each update has an **Undo**.
- **It won't invent client details.** Names, phones, emails and addresses only come from what you type.
- **It sees the current form.** Edits you make by hand are seen on your next message.
- **Conversations aren't stored.** They last until you click New chat or reload the page. Photos are shrunk before upload.
- Model: Claude Opus 5.5 (`functions/agent.js`). A typical quote costs a few cents.

## Files

- `functions/agent.js`: system prompt, tools (`search_past_quotes`, `get_business_settings`, `update_quote`) and the agent loop.
- `functions/index.js`: the `quoteAgent` callable function (signed-in users only; reads only that user's quotes and saved hourly rate).
- `index.html`: the chat panel (search for `QUOTE ASSISTANT`).
- `functions/test/agent.test.js`: tests with a fake Claude client (`npm test`).
