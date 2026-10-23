# Bote: the AI treasurer for every group

> *"Bote"* is Spanish for the shared kitty a group puts money into.

Every group has one person who fronts the money and then spends weeks chasing everyone else: the trip, the match tickets, the birthday dinner, the club dues. **Bote is an AI agent that does that job end to end with PayPal.**

You tell it the plan in your own words, for example *"We're 6 going to the derby: tickets 45 € each, the bus is 300 € for Autocares Triana, and Juan already paid 60 € for snacks"*. Bote then:

1. **Understands the plan** and keeps an exact ledger: who is in, what each thing costs, who fronted what.
2. **Collects** from everyone with PayPal: a PayPal invoice plus a one-tap PayPal checkout link per person. It watches payments and sends friendly reminders.
3. **Pays the vendor** from the pot with PayPal Payouts.
4. **Settles up**: it refunds overpayments or dropouts on their original PayPal payment, and reimburses people who fronted costs.

**Money only moves after the organizer taps Approve.** The AI proposes; the human decides.

## How it uses PayPal

| PayPal API | What Bote uses it for |
|---|---|
| OAuth 2.0 | Server-to-server auth for the sandbox app |
| **Orders v2** (create + capture) + **JavaScript SDK buttons** | Each member's personal pay link: one tap to pay their exact share |
| **Invoicing v2** (create, send, get, remind, cancel) | A formal PayPal invoice per member, with status sync and reminders |
| **Payments v2** (capture refund) | Give money back on the member's original payment |
| **Payouts v1** | Pay the vendor from the pot; reimburse members who fronted costs |

## How it uses AI

Bote is an LLM agent with 11 tools (`src/agent.js`). It runs on **Google Gemini** (`gemini-3.5-flash`, free tier) by default, or on **Anthropic Claude** (`claude-opus-5-5`) when `ANTHROPIC_API_KEY` is set. Both providers share the same tools and system prompt:

- **Ledger tools:** `get_group`, `add_members`, `remove_member`, `add_expense`, `update_expense`, `remove_expense`
- **PayPal tools:** `request_payments`, `check_payments`, `send_reminder`, `pay_vendor`, `settle_up`

Design choices that make it trustworthy with money:

- **The model never does arithmetic.** It decides *what* the plan is; `src/ledger.js` computes every share in integer cents, splitting remainders deterministically.
- **Human in the loop.** `request_payments`, `pay_vendor` and `settle_up` only create an approval card with the exact amounts. Nothing reaches PayPal until the organizer approves.
- **Event-driven.** Payments, approvals and failures are fed back to the agent as `[event]` messages, so it reacts in the group chat ("Pedro just paid, 2 to go: shall I remind Omar?").
- **Resilient.** It uses a model fallback chain on Gemini (overload and rate-limit retries) and server-side refusal fallback on Claude; errors surface as friendly chat messages.

## Try it live

**https://bote-yz5m.onrender.com** runs on the PayPal sandbox, so no real money moves. Create a pot, paste a suggested plan, approve, then open a member's pay link and pay with a PayPal sandbox personal account.

## Run it

Requirements: Node 20.6+.

```bash
npm install
cp .env.example .env   # add your keys
npm start              # http://localhost:3500
```

- `GEMINI_API_KEY`: free key from Google AI Studio. Alternatively, set `ANTHROPIC_API_KEY` to use Claude.
- `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`: a **sandbox** app from developer.paypal.com. Without them Bote runs in **demo mode**, with simulated PayPal calls so you can try the whole flow.
- `PUBLIC_URL`: optional; the base URL used in members' pay links.

To try it: create a pot, paste one of the suggested plans, approve the payment requests, open a member's pay link and pay with a PayPal **sandbox** personal account, then ask Bote to pay the bus and settle up.

Tests: `npm test` runs an end-to-end flow (plan → requests → payments → vendor payout → dropout refund) in demo mode.

## Project structure

```
server.js          HTTP API + server-sent events (no framework)
src/agent.js       Claude agent: system prompt, tools, agent loop
src/ledger.js      Shares, balances, settlement — integer cents
src/actions.js     Money actions that run after approval (PayPal calls)
src/paypal.js      PayPal REST client (Orders, Invoicing, Payments, Payouts) + demo mock
src/store.js       Groups, persistence, live updates
public/            Landing, organizer chat + live pot, member pay page
test/              End-to-end flow test
```

## What's next

- Group chat integrations (WhatsApp / Telegram), so Bote lives where the group already talks
- Recurring dues with PayPal Subscriptions for clubs and fan clubs (peñas)
- Multi-currency trips with automatic conversion
- PayPal webhooks instead of polling for invoice payments

## License

MIT, see [LICENSE](LICENSE). Built for the PayPal AI Hackathon 2026.
