import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const app = express();
app.use(express.json({ limit: '1mb' }));
const port = Number(process.env.API_PORT || 3001);
const region = process.env.AWS_REGION || 'us-east-1';
const modelId = process.env.BEDROCK_MODEL_ID || 'amazon.nova-lite-v1:0';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.ACTIONFLOW_DATA_DIR || path.join(__dirname, '..', '.actionflow-data'));
const dataFile = path.join(dataDir, 'state.json');
const MAX_TITLE = 160;
const MAX_ITEMS = 12;

const emptyState = () => ({ tasks: [], reminders: [], shopping: [], activity: [] });
function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
      shopping: Array.isArray(parsed.shopping) ? parsed.shopping : [],
      activity: Array.isArray(parsed.activity) ? parsed.activity.slice(0, 100) : [],
    };
  } catch { return emptyState(); }
}
let state = readState();
function persistState() {
  fs.mkdirSync(dataDir, { recursive: true });
  const tempFile = `${dataFile}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tempFile, dataFile);
}
const cloneState = () => JSON.parse(JSON.stringify(state));
const id = () => crypto.randomUUID();
const now = () => Date.now();
function logActivity(title, detail, kind) {
  state.activity.unshift({ id: id(), title, detail, createdAt: now(), kind });
  state.activity = state.activity.slice(0, 100);
}
function cleanText(value, max = MAX_TITLE) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}
function capitalize(value) { return value ? value[0].toUpperCase() + value.slice(1) : value; }

// Resolve common human time phrases to a device-local timestamp. This supports
// in-app browser notifications; the human-readable phrase remains visible too.
function resolveReminderTime(raw) {
  const value = cleanText(raw, 100).toLowerCase();
  const nowDate = new Date();
  const relative = value.match(/\bin\s+(\d+)\s+(minute|minutes|min|hour|hours|day|days)\b/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const multiplier = unit.startsWith('min') ? 60_000 : unit.startsWith('hour') ? 3_600_000 : 86_400_000;
    return new Date(nowDate.getTime() + amount * multiplier).toISOString();
  }
  const clockMatch = value.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i);
  if (clockMatch) {
    let hour = Number(clockMatch[1]);
    const minute = Number(clockMatch[2] || 0);
    const meridiem = clockMatch[3].replaceAll('.', '').toLowerCase();
    if (hour < 1 || hour > 12 || minute > 59) return null;
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    const due = new Date(nowDate);
    due.setHours(hour, minute, 0, 0);
    if (/\btomorrow\b/.test(value)) due.setDate(due.getDate() + 1);
    else if (/\bnext week\b/.test(value)) due.setDate(due.getDate() + 7);
    else if (due.getTime() <= nowDate.getTime()) due.setDate(due.getDate() + 1);
    return due.toISOString();
  }
  const dateMatch = value.match(/\b(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2}))?\b/);
  if (dateMatch) {
    const due = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), Number(dateMatch[4] || 9), Number(dateMatch[5] || 0));
    return Number.isNaN(due.getTime()) ? null : due.toISOString();
  }
  if (/\bin\s+\d+\s+(minutes?|hours?|days?)\b/.test(value)) return null;
  return null;
}

const systemPrompt = `You are ActionFlow, a safe personal assistant planning engine. Translate the user's request into a concise reply and zero or more executable actions. Return ONLY valid JSON with this shape: {"reply":"brief response","actions":[...]}. Allowed actions only: {"type":"create_task","title":"..."}, {"type":"create_reminder","title":"...","when":"..."}, {"type":"add_shopping_items","items":["..."]}. Never include other action types. Keep every action directly supported by the user's request. Never claim an action has been completed; the application executes approved actions after validation. If asked for a plan, create a useful task. If they ask for a dinner list without specifying items, use pasta, tomatoes, cheese, and leafy greens. For reminders preserve the requested date/time phrase. If intent is unclear, ask a brief question and return actions: []. Do not add external actions or invent appointments. No markdown fences.`;

function localPlan(raw) {
  const text = cleanText(raw, 2000);
  const lower = text.toLowerCase();
  const actions = [];
  if (!text) return { reply: 'Tell me what you want to get done, and I will turn it into actions.', actions };
  if (/\b(what can you do|help|capabilities|how does this work)\b/.test(lower)) {
    return { reply: 'I can create tasks, schedule in-app reminders, and build a shopping list. You can combine these in one request. Reminders can notify you while this app is open and browser notifications are enabled.', actions };
  }
  const timeMatch = lower.match(/\b(?:at\s*)?(\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?))\b/i)
    || lower.match(/\b(tomorrow|tonight|this evening|this afternoon|this morning|next week|in \d+ (?:minutes?|hours?|days?))\b/i);
  const hasReminder = /\b(remind(?:er| me)?|alert me|notify me)\b/.test(lower);
  if (hasReminder) {
    const toMatch = text.match(/remind me to\s+(.+?)(?=\s+(?:at|by|on|tomorrow|tonight|this evening|this afternoon|this morning|in \d+ minutes?|in \d+ hours?)\b|$)/i);
    const genericFor = lower.match(/reminder\s+for\s+(\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?))/i);
    let title = toMatch?.[1]?.replace(/[.!?]+$/, '').trim()
      || (/(dinner|food|meal)/i.test(text) ? 'Prepare dinner' : /demo|video|record/i.test(text) ? 'Record the demo' : /meeting/i.test(text) ? 'Prepare for the meeting' : 'Follow up');
    title = capitalize(cleanText(title));
    const rawWhen = cleanText(timeMatch?.[1] || genericFor?.[1] || 'Today', 100).replace(/\b(am|pm)\b/gi, x => x.toUpperCase());
    let when = rawWhen;
    if (/\btomorrow\b/i.test(lower) && timeMatch && !/^tomorrow$/i.test(rawWhen)) when = `Tomorrow at ${rawWhen}`;
    else if (/\btonight\b/i.test(lower) && timeMatch && !/^tonight$/i.test(rawWhen)) when = `Tonight at ${rawWhen}`;
    actions.push({ type: 'create_reminder', title, when });
  }
  const shoppingIntent = /\b(shopping list|grocery list|groceries|buy|pick up|shopping for)\b/.test(lower);
  if (shoppingIntent) {
    const itemMatch = text.match(/(?:shopping list|grocery list|groceries|buy|pick up)(?:\s+(?:for|of))?\s*[:\-]?\s+(.+?)(?:\s+and\s+(?:add|set|create|make|remind|plan)|[.!?]|$)/i);
    const candidate = itemMatch?.[1]?.trim().replace(/[,;]\s*$/, '') || '';
    const shouldUseNamedItems = candidate && !/^(dinner|tonight|today|the dinner|a list|for dinner)$/i.test(candidate) && /,|\band\b/i.test(candidate);
    let items = [];
    if (shouldUseNamedItems) items = candidate.split(/,|\band\b/i).map(s => cleanText(s, 80)).filter(s => s.length > 1).slice(0, MAX_ITEMS);
    else if (/dinner|meal|tonight|food/i.test(lower)) items = ['Pasta', 'Tomatoes', 'Cheese', 'Leafy greens'];
    else items = ['Milk', 'Eggs', 'Bread'];
    actions.push({ type: 'add_shopping_items', items });
  }
  const taskMatch = text.match(/\b(?:add|create|save|make)\s+(?:a\s+)?(?:task|todo|to-do)\s*(?:to|for|:)?\s*(.+?)(?:[.!?]|$)/i)
    || text.match(/\b(?:i need to|remember to|my priority is to)\s+(.+?)(?:[.!?]|$)/i);
  const planningIntent = /\b(plan my evening|plan my day|organize my day|make a plan|create a plan)\b/.test(lower);
  if (taskMatch) {
    const picked = taskMatch[1] || '';
    const taskTitle = cleanText(picked.replace(/[.!?]+$/, ''));
    if (taskTitle && !/^(my evening|my day|dinner)$/i.test(taskTitle)) actions.push({ type: 'create_task', title: capitalize(taskTitle) });
  } else if (planningIntent && !actions.some(a => a.type === 'create_task')) {
    actions.push({ type: 'create_task', title: /evening/.test(lower) ? 'Plan evening routine' : 'Plan my day' });
  }
  if (!actions.length) return { reply: 'I did not find a clear action to run. Try “create a task to test the demo”, “remind me to record the video tomorrow at 10 AM”, or “make a dinner shopping list”.', actions };
  const names = [...new Set(actions.map(a => a.type === 'create_task' ? 'a task' : a.type === 'create_reminder' ? 'a reminder' : 'a shopping list'))];
  return { reply: actions.length === 1 ? `I have prepared ${names[0]} for you.` : `I have prepared ${names.join(', ')}. I will save each change to your workspace.`, actions };
}

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || typeof plan.reply !== 'string' || !Array.isArray(plan.actions)) throw new Error('Invalid plan');
  const actions = [];
  for (const action of plan.actions.slice(0, 10)) {
    if (!action || typeof action !== 'object') continue;
    if (action.type === 'create_task') {
      const title = cleanText(action.title);
      if (title) actions.push({ type: 'create_task', title });
    } else if (action.type === 'create_reminder') {
      const title = cleanText(action.title);
      const when = cleanText(action.when, 100);
      if (title && when) actions.push({ type: 'create_reminder', title, when });
    } else if (action.type === 'add_shopping_items' && Array.isArray(action.items)) {
      const items = [...new Set(action.items.map(x => cleanText(x, 80)).filter(Boolean))].slice(0, MAX_ITEMS);
      if (items.length) actions.push({ type: 'add_shopping_items', items });
    }
  }
  return { reply: cleanText(plan.reply, 1200) || 'I have processed your request.', actions };
}

function bedrockCanBeAttempted() {
  if (process.env.ACTIONFLOW_LOCAL_ONLY === '1') return false;
  const hasEnvironmentCredentials = Boolean(
    process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_WEB_IDENTITY_TOKEN_FILE ||
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
    process.env.AWS_EXECUTION_ENV || process.env.AWS_LAMBDA_FUNCTION_NAME
  );
  const credentialsFile = process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(), '.aws', 'credentials');
  const configFile = process.env.AWS_CONFIG_FILE || path.join(os.homedir(), '.aws', 'config');
  return hasEnvironmentCredentials || fs.existsSync(credentialsFile) || fs.existsSync(configFile);
}
async function planWithBedrock(message) {
  const client = new BedrockRuntimeClient({ region });
  const result = await client.send(new ConverseCommand({
    modelId,
    system: [{ text: systemPrompt }],
    messages: [{ role: 'user', content: [{ text: message }] }],
    inferenceConfig: { maxTokens: 700, temperature: 0.2 },
  }));
  const responseText = result.output?.message?.content?.map(item => item.text || '').join('') || '';
  const clean = responseText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return validatePlan(JSON.parse(clean));
}
async function makePlan(message) {
  if (bedrockCanBeAttempted()) {
    try { return { provider: 'amazon-bedrock', plan: await planWithBedrock(message) }; }
    catch (error) {
      const detail = error?.name || error?.code || 'BedrockUnavailable';
      console.warn(`Bedrock unavailable (${detail}); using local planner.`);
    }
  }
  return { provider: 'server-local-agent', plan: validatePlan(localPlan(message)) };
}

function executeActions(actions) {
  const executed = [];
  for (const action of actions) {
    if (action.type === 'create_task') {
      const task = { id: id(), title: action.title, done: false, createdAt: now() };
      state.tasks.unshift(task);
      logActivity('Task created', task.title, 'task');
      executed.push(`Created task: ${task.title}`);
    } else if (action.type === 'create_reminder') {
      const reminder = { id: id(), title: action.title, when: action.when, scheduledAt: resolveReminderTime(action.when), createdAt: now(), done: false, notified: false };
      state.reminders.unshift(reminder);
      logActivity('Reminder scheduled', `${reminder.title} · ${reminder.when}`, 'reminder');
      executed.push(`Scheduled reminder: ${reminder.title} · ${reminder.when}`);
    } else if (action.type === 'add_shopping_items') {
      const existing = new Set(state.shopping.map(item => item.name.toLowerCase()));
      const fresh = action.items.filter(name => !existing.has(name.toLowerCase()));
      for (const name of fresh) state.shopping.unshift({ id: id(), name, checked: false, createdAt: now() });
      if (fresh.length) {
        logActivity('Shopping list updated', fresh.join(', '), 'shopping');
        executed.push(`Added to shopping list: ${fresh.join(', ')}`);
      } else {
        executed.push('Shopping list unchanged: those items are already on the list');
      }
    }
  }
  persistState();
  return executed;
}

const collectionConfig = {
  tasks: { activityKind: 'task', label: 'Task', allowedPatch: ['done'] },
  reminders: { activityKind: 'reminder', label: 'Reminder', allowedPatch: ['done', 'notified'] },
  shopping: { activityKind: 'shopping', label: 'Shopping item', allowedPatch: ['checked'] },
};

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    provider: process.env.ACTIONFLOW_LOCAL_ONLY === '1' ? 'local-only' : bedrockCanBeAttempted() ? 'bedrock-configured' : 'local-agent',
    modelId, region, storage: 'file-backed-json', notifications: 'browser-while-app-open',
  });
});
app.get('/api/state', (_req, res) => res.json({ state: cloneState() }));

app.post('/api/state/import', (req, res) => {
  const incoming = req.body?.state;
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'A state object is required.' });
  const isEmpty = !state.tasks.length && !state.reminders.length && !state.shopping.length && !state.activity.length;
  if (!isEmpty) return res.status(409).json({ error: 'The server workspace already contains data.', state: cloneState() });
  const safeArr = (key, max) => Array.isArray(incoming[key]) ? incoming[key].slice(0, max) : [];
  state = {
    tasks: safeArr('tasks', 500).filter(x => x && typeof x.title === 'string').map(x => ({ id: cleanText(x.id, 80) || id(), title: cleanText(x.title), done: Boolean(x.done), createdAt: Number(x.createdAt) || now() })),
    reminders: safeArr('reminders', 500).filter(x => x && typeof x.title === 'string').map(x => ({ id: cleanText(x.id, 80) || id(), title: cleanText(x.title), when: cleanText(x.when || 'Today', 100), scheduledAt: typeof x.scheduledAt === 'string' ? x.scheduledAt : resolveReminderTime(x.when || 'Today'), createdAt: Number(x.createdAt) || now(), done: Boolean(x.done), notified: Boolean(x.notified) })),
    shopping: safeArr('shopping', 1000).filter(x => x && typeof x.name === 'string').map(x => ({ id: cleanText(x.id, 80) || id(), name: cleanText(x.name, 80), checked: Boolean(x.checked), createdAt: Number(x.createdAt) || now() })),
    activity: safeArr('activity', 100).filter(x => x && typeof x.title === 'string').map(x => ({ id: cleanText(x.id, 80) || id(), title: cleanText(x.title), detail: cleanText(x.detail || '', 300), kind: ['task','reminder','shopping','assistant'].includes(x.kind) ? x.kind : 'assistant', createdAt: Number(x.createdAt) || now() })),
  };
  persistState();
  res.json({ ok: true, state: cloneState() });
});

app.post('/api/assistant', async (req, res) => {
  const message = cleanText(req.body?.message, 2000);
  if (!message) return res.status(400).json({ error: 'Message is required.' });
  try {
    const { provider, plan } = await makePlan(message);
    const executed = executeActions(plan.actions);
    logActivity('Assistant handled a request', message, 'assistant');
    persistState();
    res.json({ provider, plan, executed, state: cloneState() });
  } catch (error) {
    console.error('Assistant request failed:', error?.message || error);
    res.status(500).json({ error: 'The assistant could not process that request. Please try again.' });
  }
});

app.post('/api/plan', async (req, res) => {
  const message = cleanText(req.body?.message, 2000);
  if (!message) return res.status(400).json({ error: 'Message is required.' });
  const result = await makePlan(message);
  res.json(result);
});

app.post('/api/reset', (_req, res) => {
  state = emptyState();
  persistState();
  res.json({ ok: true, state: cloneState() });
});

app.post('/api/:collection', (req, res) => {
  const { collection } = req.params;
  const config = collectionConfig[collection];
  if (!config) return res.status(404).json({ error: 'Unknown collection.' });
  const createdAt = now();
  let item;
  if (collection === 'tasks') {
    const title = cleanText(req.body?.title);
    if (!title) return res.status(400).json({ error: 'Task title is required.' });
    item = { id: id(), title, done: false, createdAt };
  } else if (collection === 'reminders') {
    const title = cleanText(req.body?.title);
    const when = cleanText(req.body?.when || 'Today', 100);
    if (!title) return res.status(400).json({ error: 'Reminder title is required.' });
    item = { id: id(), title, when, scheduledAt: resolveReminderTime(when), createdAt, done: false, notified: false };
  } else {
    const names = Array.isArray(req.body?.items) ? req.body.items.map(x => cleanText(x, 80)).filter(Boolean).slice(0, MAX_ITEMS) : [];
    if (!names.length) return res.status(400).json({ error: 'At least one shopping item is required.' });
    const existing = new Set(state.shopping.map(x => x.name.toLowerCase()));
    const fresh = [];
    for (const name of names) {
      const normalized = name.toLowerCase();
      if (!existing.has(normalized)) { existing.add(normalized); fresh.push(name); }
    }
    fresh.forEach(name => state.shopping.unshift({ id: id(), name, checked: false, createdAt }));
    if (fresh.length) logActivity('Shopping list updated', fresh.join(', '), 'shopping');
    persistState();
    return res.json({ ok: true, itemsAdded: fresh.length, state: cloneState() });
  }
  state[collection].unshift(item);
  logActivity(`${config.label} created`, collection === 'reminders' ? `${item.title} · ${item.when}` : item.title, config.activityKind);
  persistState();
  res.json({ ok: true, item, state: cloneState() });
});

app.patch('/api/:collection/:itemId', (req, res) => {
  const { collection, itemId } = req.params;
  const config = collectionConfig[collection];
  if (!config) return res.status(404).json({ error: 'Unknown collection.' });
  const item = state[collection].find(x => x.id === itemId);
  if (!item) return res.status(404).json({ error: 'Item not found.' });
  const patchKey = config.allowedPatch.find(key => typeof req.body?.[key] === 'boolean');
  if (!patchKey) return res.status(400).json({ error: `Supply a boolean ${config.allowedPatch.join(' or ')} value.` });
  item[patchKey] = req.body[patchKey];
  if (collection === 'reminders' && patchKey === 'done' && item.done) item.notified = true;
  if (patchKey !== 'notified') logActivity(`${config.label} ${item[patchKey] ? 'updated' : 'reopened'}`, item.title || item.name, config.activityKind);
  persistState();
  res.json({ ok: true, item, state: cloneState() });
});

app.delete('/api/:collection/:itemId', (req, res) => {
  const { collection, itemId } = req.params;
  if (!collectionConfig[collection]) return res.status(404).json({ error: 'Unknown collection.' });
  const items = state[collection];
  const existingItem = items.find(x => x.id === itemId);
  if (!existingItem) return res.status(404).json({ error: 'Item not found.' });
  state[collection] = items.filter(x => x.id !== itemId);
  const config = collectionConfig[collection];
  logActivity(`${config.label} removed`, existingItem.title || existingItem.name, config.activityKind);
  persistState();
  res.json({ ok: true, state: cloneState() });
});

app.listen(port, () => console.log(`ActionFlow API listening on http://localhost:${port} (storage: ${dataFile})`));
