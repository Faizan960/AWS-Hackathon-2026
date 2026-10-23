# ActionFlow — Alexa+ experience simulation

ActionFlow is an independent Alexa+-style web simulation for demonstrating agentic workflows. It accepts a natural-language request, plans a set of permitted actions, executes those actions through a local API, and persists the resulting workspace. It is **not an official Amazon/Alexa product and does not connect to Alexa+ Preview**.

## What's actually implemented

- **Server-side action execution:** the assistant endpoint validates and executes a restricted action set (`create_task`, `create_reminder`, `add_shopping_items`).
- **Persistent data:** tasks, reminders, shopping items, and activity events are written atomically to `.actionflow-data/state.json`. They survive browser refreshes and API restarts on the same machine.
- **Real CRUD operations:** add, complete/check, and delete operations use the API when available. The UI falls back to browser storage if the API is unavailable.
- **AI planner:** optional Amazon Bedrock `Converse` integration (default model ID: `amazon.nova-lite-v1:0`). The server validates model output before executing anything.
- **Deterministic fallback:** the app works without Bedrock credentials. A local planner handles the included request patterns, and the three tools still execute against the server-backed store.
- **Browser reminders:** reminders with a recognized time can trigger browser notifications while the app is open and notification permission is granted. This is not a background/OS alarm when the browser is closed.
- **Voice input:** uses browser Web Speech recognition where supported (usually current Chrome/Edge). It captures a transcript for review; the user still sends the request.
- **Responsive workspace:** assistant chat, tasks, reminders, shopping list, and activity history.

## Run locally

Requirements: Node.js 20+ and npm.

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. The frontend is served by Vite and the API by Express at `http://localhost:3001`. The Vite dev server proxies `/api` requests to the API server. Keep the terminal running while using the app.

The standalone `demo.html` is a simpler offline fallback. Use the Vite app at `http://localhost:5173` to test the full API, server persistence, voice input, and optional Bedrock path.

## Configure Amazon Bedrock (optional)

The project does not need AWS credentials for local development. Without a configured AWS profile/role/credential chain it uses the deterministic local planner.

1. Configure an AWS profile with credentials for a principal permitted to invoke a Bedrock model, for example via AWS IAM Identity Center/SSO or your existing AWS CLI setup.
2. Copy `.env.example` to `.env`.
3. Set the region, model ID, and profile if you use a named profile.
4. Restart `npm run dev`.

Example `.env` values:

```dotenv
AWS_REGION=us-east-1
BEDROCK_MODEL_ID=amazon.nova-lite-v1:0
AWS_PROFILE=default
```

Only set `AWS_PROFILE` if that profile exists in your local AWS configuration. Never commit `.env` or long-lived AWS credentials. Ensure the model is available to your account/region and that the role has the required Bedrock invoke permission. To force the deterministic planner, set `ACTIONFLOW_LOCAL_ONLY=1`.

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | Runtime/provider/storage status |
| `GET` | `/api/state` | Read all workspace state |
| `POST` | `/api/assistant` | Plan, validate, execute, and persist a natural-language request |
| `POST` | `/api/tasks` | Create a task |
| `PATCH` / `DELETE` | `/api/tasks/:id` | Complete/reopen or remove a task |
| `POST` | `/api/reminders` | Create a reminder |
| `PATCH` / `DELETE` | `/api/reminders/:id` | Complete/reopen or remove a reminder; mark notification delivered |
| `POST` | `/api/shopping` | Add shopping items |
| `PATCH` / `DELETE` | `/api/shopping/:id` | Check/uncheck or remove an item |
| `POST` | `/api/reset` | Clear the local server workspace |

The state file is local application data; it is not encrypted or appropriate for secrets or sensitive personal information. For a hosted or multi-user deployment, replace this file store with a managed database, add authentication/authorization, and deploy behind HTTPS before exposing it to the internet.

## Smoke test

With dependencies installed, run:

```bash
npm run test:smoke
```

The test launches an isolated local API in deterministic mode and verifies health, the three-action workflow, persisted state, task updates, and reset. It uses a temporary data directory and deletes it when finished.

## Suggested demo walkthrough (60–90 seconds)

1. Click **Do all three** or ask: “Plan my evening, make a shopping list for dinner, and add a reminder for 7 PM.”
2. Show the three server-executed actions and open Tasks, Shopping list, and Reminders.
3. Complete a task and check off a shopping item.
4. Refresh the browser to show server persistence.
5. If testing notifications, open Reminders, enable browser notifications, and create a reminder for a near-future time.
6. If using Bedrock, show the provider label and state clearly that the project is an Alexa+ simulation, not a live Alexa+ integration.

## Build and production preview

```bash
npm run build
npm run preview
```

The production frontend needs the Express API deployed separately and configured to serve `/api` requests. The Vite proxy applies only during development. For a production demo, host the API and frontend behind one origin or set an explicit API base URL and configure CORS securely.
