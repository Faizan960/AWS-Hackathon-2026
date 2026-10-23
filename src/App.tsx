import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowRight, ArrowUpRight, Bot, Check, CheckCheck,
  CheckCircle2, CircleHelp, Clock3, Command, ListChecks,
  ListTodo, LoaderCircle, MessageCircle, Mic, Plus, Send, Settings2, ShoppingBasket,
  Sparkles, Stars, Sun, Trash2, WandSparkles, X,
} from 'lucide-react';

type View = 'assistant' | 'tasks' | 'reminders' | 'shopping' | 'activity';
type Task = { id: string; title: string; done: boolean; createdAt: number };
type Reminder = { id: string; title: string; when: string; scheduledAt?: string | null; notified?: boolean; createdAt: number; done: boolean };
type ActivityItem = { id: string; title: string; detail: string; createdAt: number; kind: 'task' | 'reminder' | 'shopping' | 'assistant' };
type ShoppingItem = { id: string; name: string; checked: boolean };
type Message = { id: string; role: 'assistant' | 'user'; content: string; time: string; actions?: string[]; provider?: string };
type PlannedAction =
  | { type: 'create_task'; title: string }
  | { type: 'create_reminder'; title: string; when: string }
  | { type: 'add_shopping_items'; items: string[] };

type StoredState = { tasks: Task[]; reminders: Reminder[]; shopping: ShoppingItem[]; activity: ActivityItem[] };
type SpeechEventLike = { results: ArrayLike<ArrayLike<{ transcript: string }>> };
type SpeechRecognitionLike = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: SpeechEventLike) => void) | null;
  onerror: ((event?: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void; stop: () => void;
};
type SpeechWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
};
const STORAGE_KEY = 'actionflow-state-v1';
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const clock = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const whenText = (raw: string) => raw.trim().replace(/\s+/g, ' ');
const resolveLocalReminderTime = (raw: string): string | null => {
  const value = raw.trim().toLowerCase();
  const relative = value.match(/\bin\s+(\d+)\s+(minute|minutes|min|hour|hours|day|days)\b/);
  if (relative) {
    const scale = relative[2].startsWith('min') ? 60_000 : relative[2].startsWith('hour') ? 3_600_000 : 86_400_000;
    return new Date(Date.now() + Number(relative[1]) * scale).toISOString();
  }
  const match = value.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = match[3].replace(/\./g, '').toLowerCase();
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  const due = new Date();
  due.setHours(hour, minute, 0, 0);
  if (/\btomorrow\b/.test(value) || (!/\btoday\b/.test(value) && due.getTime() <= Date.now())) due.setDate(due.getDate() + 1);
  return due.toISOString();
};

async function apiRequest<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload as T;
}

const hasStoredItems = (state: StoredState) => state.tasks.length + state.reminders.length + state.shopping.length + state.activity.length > 0;
const readSaved = (): StoredState => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      return {
        tasks: Array.isArray(saved.tasks) ? saved.tasks : [],
        reminders: Array.isArray(saved.reminders) ? saved.reminders : [],
        shopping: Array.isArray(saved.shopping) ? saved.shopping : [],
        activity: Array.isArray(saved.activity) ? saved.activity : [],
      };
    }
  } catch { /* recover with a clean local session */ }
  return { tasks: [], reminders: [], shopping: [], activity: [] };
};

const suggestions = [
  { icon: ListChecks, title: 'Plan my evening', prompt: 'Plan my evening and create a short task list for it.' },
  { icon: ShoppingBasket, title: 'Dinner shopping', prompt: 'Prepare a shopping list for dinner tonight.' },
  { icon: Clock3, title: 'Set a reminder', prompt: 'Add a reminder to record my demo tomorrow at 10 AM.' },
  { icon: Sparkles, title: 'Do all three', prompt: 'Plan my evening, make a shopping list for dinner, and add a reminder for 7 PM.' },
];

function inferPlan(raw: string): { reply: string; actions: PlannedAction[] } {
  const text = raw.trim();
  const lower = text.toLowerCase();
  const actions: PlannedAction[] = [];
  if (!text) return { reply: 'Tell me what you want to get done, and I’ll turn it into actions.', actions };
  if (/\b(what can you do|help|capabilities|how does this work)\b/.test(lower)) {
    return { reply: 'I can create tasks, set reminders, and build a shopping list. Try asking for a few things in one message and I’ll execute each action.', actions };
  }
  if (/\b(clear|reset) (the )?(demo|app|all data|everything)\b/.test(lower)) {
    return { reply: 'Use the reset control in the sidebar to clear demo data safely. I won’t erase your saved items from a conversational guess.', actions };
  }

  const timeMatch = lower.match(/\b(?:at\s*)?(\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?))\b/)
    || lower.match(/\b(tomorrow|tonight|this evening|this afternoon|this morning|next week|in \d+ (?:minutes?|hours?|days?))\b/);
  const hasReminder = /\b(remind(?:er| me)?|alert me|notify me)\b/.test(lower);
  if (hasReminder) {
    const toMatch = text.match(/remind me to\s+(.+?)(?=\s+(?:at|by|on|tomorrow|tonight|this evening|this afternoon|this morning)\b|$)/i);
    const genericFor = lower.match(/reminder\s+for\s+(\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?))/i);
    const title = toMatch?.[1]?.replace(/[.!?]+$/, '').trim()
      || (/(dinner|food|meal)/i.test(text) ? 'Prepare dinner' : /demo|video|record/i.test(text) ? 'Record the demo' : /meeting/i.test(text) ? 'Prepare for the meeting' : 'Follow up');
    const rawWhen = whenText(timeMatch?.[1] || genericFor?.[1] || 'Today').replace(/\b(am|pm)\b/gi, value => value.toUpperCase());
    const when = /\btomorrow\b/i.test(lower) && timeMatch ? `Tomorrow at ${rawWhen}` : /\btonight\b/i.test(lower) && timeMatch ? `Tonight at ${rawWhen}` : rawWhen;
    actions.push({ type: 'create_reminder', title: title.charAt(0).toUpperCase() + title.slice(1), when });
  }

  const shoppingIntent = /\b(shopping list|grocery list|groceries|buy|pick up|shopping for)\b/.test(lower);
  if (shoppingIntent) {
    let items: string[] = [];
    const itemMatch = text.match(/(?:shopping list|grocery list|groceries|buy|pick up)(?:\s+(?:for|of))?\s*[:\-]?\s+(.+?)(?:\s+and\s+(?:add|set|create|make|remind|plan)|[.!?]|$)/i);
    const candidate = itemMatch?.[1]?.trim().replace(/[,;]\s*$/, '') || '';
    const appearsToListItems = candidate && !/^(dinner|tonight|today|the dinner|a list|for dinner)$/i.test(candidate) && /,|\band\b/.test(candidate);
    if (appearsToListItems) {
      items = candidate.split(/,|\band\b/i).map(s => s.trim()).filter(s => s.length > 1).slice(0, 12);
    } else if (/dinner|meal|tonight|food/i.test(lower)) {
      items = ['Pasta', 'Tomatoes', 'Cheese', 'Leafy greens'];
    } else {
      items = ['Milk', 'Eggs', 'Bread'];
    }
    actions.push({ type: 'add_shopping_items', items });
  }

  const taskMatch = text.match(/\b(?:add|create|save|make)\s+(?:a\s+)?(?:task|todo|to-do)\s*(?:to|for|:)?\s*(.+?)(?:[.!?]|$)/i)
    || text.match(/\b(?:i need to|remember to|my priority is to)\s+(.+?)(?:[.!?]|$)/i);
  const planningIntent = /\b(plan my evening|plan my day|organize my day|make a plan|create a plan)\b/.test(lower);
  const taskExists = actions.some(a => a.type === 'create_task');
  if (taskMatch) {
    const picked = taskMatch[1] || taskMatch[2] || '';
    const taskTitle = picked.trim().replace(/[.!?]+$/, '');
    if (taskTitle && !/^(my evening|my day|dinner)$/i.test(taskTitle)) actions.push({ type: 'create_task', title: taskTitle.charAt(0).toUpperCase() + taskTitle.slice(1) });
  } else if (planningIntent && !taskExists) {
    actions.push({ type: 'create_task', title: /evening/.test(lower) ? 'Plan evening routine' : 'Plan my day' });
  }

  if (actions.length === 0) {
    return { reply: 'I can turn that into a task, reminder, or shopping list. Try something like “Add a task to test the demo” or “Remind me to record the video tomorrow at 10 AM.”', actions };
  }
  const names = actions.map((a) => a.type === 'create_task' ? 'a task' : a.type === 'create_reminder' ? 'a reminder' : 'a shopping list');
  const uniqueNames = [...new Set(names)];
  const reply = actions.length === 1
    ? `Done — I’ve added ${uniqueNames[0]} below.`
    : `Done — I’ve coordinated ${uniqueNames.join(', ')} and added the results to your workspace.`;
  return { reply, actions };
}

function App() {
  const saved = useMemo(readSaved, []);
  const [tasks, setTasks] = useState<Task[]>(saved.tasks);
  const [reminders, setReminders] = useState<Reminder[]>(saved.reminders);
  const [shopping, setShopping] = useState<ShoppingItem[]>(saved.shopping);
  const [activity, setActivity] = useState<ActivityItem[]>(saved.activity);
  const [view, setView] = useState<View>('assistant');
  const [draft, setDraft] = useState('');
  const [processing, setProcessing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [backendConnected, setBackendConnected] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | 'unsupported'>(() => typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported');
  const dueNotifiedRef = useRef<Set<string>>(new Set());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState<Message[]>([
    { id: 'welcome', role: 'assistant', content: 'Hey there. What can I take off your plate today?', time: clock() },
    { id: 'welcome-note', role: 'assistant', content: 'I can work across tasks, reminders, and shopping lists in one request. Try one of the examples below, or tell me what you need in your own words.', time: clock() },
  ]);

  const applyState = (next: StoredState) => {
    if (!next || !Array.isArray(next.tasks) || !Array.isArray(next.reminders) || !Array.isArray(next.shopping) || !Array.isArray(next.activity)) return;
    setTasks(next.tasks);
    setReminders(next.reminders);
    setShopping(next.shopping);
    setActivity(next.activity);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* the server copy remains authoritative when available */ }
  };

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tasks, reminders, shopping, activity } satisfies StoredState));
  }, [tasks, reminders, shopping, activity]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let data = await apiRequest<{ state: StoredState }>('/api/state');
        const remote = data.state;
        if (!hasStoredItems(remote) && hasStoredItems(saved)) {
          try { data = await apiRequest<{ state: StoredState }>('/api/state/import', { method: 'POST', body: JSON.stringify({ state: saved }) }); }
          catch { data = await apiRequest<{ state: StoredState }>('/api/state'); }
        }
        if (cancelled) return;
        applyState(data.state);
        setBackendConnected(true);
      } catch {
        if (!cancelled) setBackendConnected(false);
      }
    })();
    return () => { cancelled = true; };
  // Initial hydration is intentional: the server is authoritative once it responds.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, processing]);
  useEffect(() => {
    if (notificationPermission !== 'granted') return;
    const checkDueReminders = () => {
      const current = Date.now();
      for (const reminder of reminders) {
        if (reminder.done || reminder.notified || !reminder.scheduledAt || dueNotifiedRef.current.has(reminder.id)) continue;
        const due = new Date(reminder.scheduledAt).getTime();
        if (!Number.isFinite(due) || due > current) continue;
        dueNotifiedRef.current.add(reminder.id);
        try { new Notification(`ActionFlow reminder: ${reminder.title}`, { body: `Scheduled for ${reminder.when}` }); } catch { /* browser notifications may be blocked */ }
        void apiRequest(`/api/reminders/${reminder.id}`, { method: 'PATCH', body: JSON.stringify({ notified: true }) })
          .then(result => { if (result.state) applyState(result.state); })
          .catch(() => setReminders(prev => prev.map(item => item.id === reminder.id ? { ...item, notified: true } : item)));
      }
    };
    checkDueReminders();
    const timer = window.setInterval(checkDueReminders, 15_000);
    return () => window.clearInterval(timer);
  }, [reminders, notificationPermission]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const incompleteTasks = tasks.filter(t => !t.done);
  const openReminders = reminders.filter(r => !r.done);
  const uncheckedItems = shopping.filter(i => !i.checked);

  const addActivity = (title: string, detail: string, kind: ActivityItem['kind']) => {
    setActivity(prev => [{ id: uid(), title, detail, createdAt: Date.now(), kind }, ...prev].slice(0, 50));
  };

  const mutateApi = async (path: string, init: RequestInit, fallback: () => void, successToast: string) => {
    try {
      const result = await apiRequest<{ state: StoredState }>(path, init);
      if (result.state) applyState(result.state);
      setBackendConnected(true);
      setToast(successToast);
      return true;
    } catch {
      setBackendConnected(false);
      fallback();
      setToast('Saved in browser-only mode');
      return false;
    }
  };

  const enableNotifications = async () => {
    if (!('Notification' in window)) {
      setNotificationPermission('unsupported');
      setToast('This browser does not support notifications');
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
      setToast(permission === 'granted' ? 'Browser notifications enabled' : 'Notification permission was not granted');
    } catch { setToast('Could not enable browser notifications'); }
  };

  const toggleVoiceInput = () => {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const speechWindow = window as SpeechWindow;
    const SpeechApi = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!SpeechApi) {
      setToast('Voice input is not supported in this browser. Try current Chrome or Edge.');
      return;
    }
    try {
      const recognition = new SpeechApi();
      recognition.lang = 'en-IN';
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.onresult = event => {
        const transcript = event.results[0]?.[0]?.transcript?.trim();
        if (transcript) {
          setDraft(transcript);
          setToast('Voice captured. Review the request, then send it.');
          inputRef.current?.focus();
        }
      };
      recognition.onerror = event => {
        setToast(event?.error === 'not-allowed' ? 'Allow microphone access to use voice input.' : 'Voice input failed. You can type your request instead.');
      };
      recognition.onend = () => { setListening(false); recognitionRef.current = null; };
      recognitionRef.current = recognition;
      setListening(true);
      recognition.start();
    } catch {
      setListening(false);
      recognitionRef.current = null;
      setToast('Could not start voice input. Check microphone permission.');
    }
  };

  useEffect(() => () => { recognitionRef.current?.stop(); }, []);

  const executeActions = (actions: PlannedAction[]): string[] => {
    const executed: string[] = [];
    for (const action of actions) {
      if (action.type === 'create_task' && action.title.trim()) {
        const title = action.title.trim();
        setTasks(prev => [{ id: uid(), title, done: false, createdAt: Date.now() }, ...prev]);
        addActivity('Task created', title, 'task');
        executed.push(`Created task: ${title}`);
      } else if (action.type === 'create_reminder' && action.title.trim()) {
        const title = action.title.trim();
        const when = whenText(action.when || 'Today');
        const scheduledAt = resolveLocalReminderTime(when);
        setReminders(prev => [{ id: uid(), title, when, scheduledAt, notified: false, createdAt: Date.now(), done: false }, ...prev]);
        addActivity('Reminder set', `${title} · ${when}`, 'reminder');
        executed.push(`Set reminder: ${title} · ${when}`);
      } else if (action.type === 'add_shopping_items' && Array.isArray(action.items)) {
        const newItems = action.items.map(name => String(name).trim()).filter(Boolean).slice(0, 12);
        setShopping(prev => {
          const existing = new Set(prev.map(item => item.name.toLowerCase()));
          const fresh = newItems.filter(name => !existing.has(name.toLowerCase()));
          return [...fresh.map(name => ({ id: uid(), name, checked: false })), ...prev];
        });
        addActivity('Shopping list updated', newItems.join(', '), 'shopping');
        executed.push(`Added to shopping list: ${newItems.join(', ')}`);
      }
    }
    if (executed.length) setToast(`${executed.length} ${executed.length === 1 ? 'action' : 'actions'} completed`);
    return executed;
  };

  const sendMessage = async (value?: string) => {
    const text = (value ?? draft).trim();
    if (!text || processing) return;
    setDraft('');
    setMessages(prev => [...prev, { id: uid(), role: 'user', content: text, time: clock() }]);
    setProcessing(true);
    let plan: { reply: string; actions: PlannedAction[] } | null = null;
    let provider = 'browser-fallback';
    let executed: string[] = [];
    let handledOnServer = false;
    try {
      const result = await apiRequest<{ provider: string; plan: { reply: string; actions: PlannedAction[] }; executed: string[]; state: StoredState }>('/api/assistant', {
        method: 'POST', body: JSON.stringify({ message: text }),
      });
      plan = result.plan;
      provider = result.provider || 'server-local-agent';
      executed = Array.isArray(result.executed) ? result.executed : [];
      if (result.state) applyState(result.state);
      setBackendConnected(true);
      handledOnServer = true;
    } catch {
      // The browser planner remains a real offline path if the server is stopped.
      setBackendConnected(false);
    }
    if (!handledOnServer) {
      plan = inferPlan(text);
      executed = executeActions(plan.actions);
      addActivity('Assistant handled a request', text, 'assistant');
    }
    if (plan!.actions.length && executed.length === 0) {
      plan!.reply = handledOnServer
        ? 'I could not complete the requested changes. Please review the request and try again.'
        : 'I could not safely execute that action. Try a task, reminder, or shopping-list request.';
    }
    setMessages(prev => [...prev, { id: uid(), role: 'assistant', content: plan!.reply, time: clock(), actions: executed, provider }]);
    setProcessing(false);
  };

  const onSubmit = (event: FormEvent) => { event.preventDefault(); void sendMessage(); };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); }
  };

  const toggleTask = (itemId: string) => {
    const task = tasks.find(t => t.id === itemId);
    if (!task) return;
    void mutateApi(`/api/tasks/${itemId}`, { method: 'PATCH', body: JSON.stringify({ done: !task.done }) }, () => {
      setTasks(prev => prev.map(t => t.id === itemId ? { ...t, done: !t.done } : t));
      addActivity(task.done ? 'Task reopened' : 'Task completed', task.title, 'task');
    }, task.done ? 'Task reopened' : 'Task completed');
  };
  const toggleReminder = (itemId: string) => {
    const reminder = reminders.find(r => r.id === itemId);
    if (!reminder) return;
    void mutateApi(`/api/reminders/${itemId}`, { method: 'PATCH', body: JSON.stringify({ done: !reminder.done }) }, () => {
      setReminders(prev => prev.map(r => r.id === itemId ? { ...r, done: !r.done } : r));
      addActivity(reminder.done ? 'Reminder reopened' : 'Reminder completed', reminder.title, 'reminder');
    }, reminder.done ? 'Reminder reopened' : 'Reminder completed');
  };
  const toggleShopping = (itemId: string) => {
    const item = shopping.find(i => i.id === itemId);
    if (!item) return;
    void mutateApi(`/api/shopping/${itemId}`, { method: 'PATCH', body: JSON.stringify({ checked: !item.checked }) }, () => {
      setShopping(prev => prev.map(i => i.id === itemId ? { ...i, checked: !i.checked } : i));
    }, item.checked ? 'Item unchecked' : 'Item checked off');
  };
  const removeTask = (itemId: string) => void mutateApi(`/api/tasks/${itemId}`, { method: 'DELETE' }, () => setTasks(prev => prev.filter(t => t.id !== itemId)), 'Task removed');
  const removeReminder = (itemId: string) => void mutateApi(`/api/reminders/${itemId}`, { method: 'DELETE' }, () => setReminders(prev => prev.filter(r => r.id !== itemId)), 'Reminder removed');
  const removeShopping = (itemId: string) => void mutateApi(`/api/shopping/${itemId}`, { method: 'DELETE' }, () => setShopping(prev => prev.filter(i => i.id !== itemId)), 'Item removed');
  const clearDemo = () => {
    if (!window.confirm('Clear all ActionFlow tasks, reminders, shopping items, and activity from this workspace?')) return;
    void mutateApi('/api/reset', { method: 'POST', body: JSON.stringify({}) }, () => {
      setTasks([]); setReminders([]); setShopping([]); setActivity([]);
      localStorage.removeItem(STORAGE_KEY);
    }, 'Workspace cleared').then(() => {
      setMessages([{ id: uid(), role: 'assistant', content: 'Workspace cleared. What should we organize next?', time: clock() }]);
      localStorage.removeItem(STORAGE_KEY);
    });
  };

  const navItems: { id: View; label: string; icon: typeof MessageCircle; count?: number }[] = [
    { id: 'assistant', label: 'Assistant', icon: MessageCircle },
    { id: 'tasks', label: 'Tasks', icon: ListTodo, count: incompleteTasks.length },
    { id: 'reminders', label: 'Reminders', icon: Clock3, count: openReminders.length },
    { id: 'shopping', label: 'Shopping list', icon: ShoppingBasket, count: uncheckedItems.length },
    { id: 'activity', label: 'Activity', icon: Activity },
  ];

  const viewHeading: Record<View, { title: string; subtitle: string }> = {
    assistant: { title: 'Your day, in motion.', subtitle: 'One request. Multiple actions. Less admin.' },
    tasks: { title: 'Your tasks', subtitle: 'Keep the important things moving.' },
    reminders: { title: 'Your reminders', subtitle: 'The little things, remembered.' },
    shopping: { title: 'Shopping list', subtitle: 'Everything you need, all in one place.' },
    activity: { title: 'Recent activity', subtitle: 'See what ActionFlow has taken care of.' },
  };

  const renderTasks = (compact = false) => tasks.length ? <div className={`item-list ${compact ? 'compact-list' : ''}`}>
    {tasks.slice(0, compact ? 4 : 100).map(task => <div className={`list-row ${task.done ? 'is-done' : ''}`} key={task.id}>
      <button className={`check-control ${task.done ? 'checked' : ''}`} aria-label={task.done ? 'Mark task incomplete' : 'Complete task'} onClick={() => toggleTask(task.id)}>{task.done && <Check size={13} />}</button>
      <span className="list-row-title">{task.title}</span>
      {!compact && <button className="icon-button quiet" title="Delete task" onClick={() => removeTask(task.id)}><Trash2 size={15} /></button>}
    </div>)}</div> : <EmptyState icon={<ListChecks size={20} />} title="No tasks yet" body="Ask the assistant to add a task, or create one below." />;

  const renderReminders = (compact = false) => reminders.length ? <div className={`item-list ${compact ? 'compact-list' : ''}`}>
    {reminders.slice(0, compact ? 3 : 100).map(reminder => <div className={`reminder-row ${reminder.done ? 'is-done' : ''}`} key={reminder.id}>
      <button className={`reminder-dot ${reminder.done ? 'done' : ''}`} onClick={() => toggleReminder(reminder.id)} aria-label={reminder.done ? 'Reopen reminder' : 'Complete reminder'}>{reminder.done ? <Check size={12} /> : <Clock3 size={13} />}</button>
      <div className="row-copy"><span className="list-row-title">{reminder.title}</span><span className="row-subtitle">{reminder.when}</span></div>
      {!compact && <button className="icon-button quiet" title="Delete reminder" onClick={() => removeReminder(reminder.id)}><Trash2 size={15} /></button>}
    </div>)}</div> : <EmptyState icon={<Clock3 size={20} />} title="Nothing on the clock" body="Set a reminder and it will appear here." />;

  const renderShopping = (compact = false) => shopping.length ? <div className={`item-list ${compact ? 'compact-list' : ''}`}>
    {shopping.slice(0, compact ? 5 : 100).map(item => <div className={`list-row ${item.checked ? 'is-done' : ''}`} key={item.id}>
      <button className={`check-control ${item.checked ? 'checked' : ''}`} aria-label={item.checked ? 'Uncheck item' : 'Check off item'} onClick={() => toggleShopping(item.id)}>{item.checked && <Check size={13} />}</button>
      <span className="list-row-title">{item.name}</span>
      {!compact && <button className="icon-button quiet" title="Remove item" onClick={() => removeShopping(item.id)}><X size={15} /></button>}
    </div>)}</div> : <EmptyState icon={<ShoppingBasket size={20} />} title="Your list is clear" body="Ask for a shopping list or add a few items below." />;

  const renderActivity = (limit = 8) => activity.length ? <div className="activity-list">{activity.slice(0, limit).map(item => {
    const Icon = item.kind === 'task' ? ListChecks : item.kind === 'reminder' ? Clock3 : item.kind === 'shopping' ? ShoppingBasket : Sparkles;
    return <div className="activity-row" key={item.id}><div className={`activity-icon ${item.kind}`}><Icon size={15} /></div><div className="row-copy"><span className="activity-title">{item.title}</span><span className="row-subtitle">{item.detail}</span></div><span className="activity-time">{new Date(item.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></div>;
  })}</div> : <EmptyState icon={<Activity size={20} />} title="No activity yet" body="Actions you run will show up here." />;

  const pageTitle = viewHeading[view];
  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <div className="brand-lockup"><div className="brand-mark"><Sparkles size={19} strokeWidth={2.4} /></div><div><div className="brand-name">actionflow<span>®</span></div><div className="brand-sub">PERSONAL AI WORKSPACE</div></div><button className="mobile-close icon-button" onClick={() => setSidebarOpen(false)} aria-label="Close navigation"><X size={18} /></button></div>
      <div className="workspace-label">WORKSPACE</div>
      <nav className="main-nav">{navItems.map(item => { const Icon = item.icon; return <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} onClick={() => { setView(item.id); setSidebarOpen(false); }}><Icon size={18} strokeWidth={1.8} /><span>{item.label}</span>{typeof item.count === 'number' && item.count > 0 && <span className="nav-count">{item.count}</span>}</button>; })}</nav>
      <div className="sidebar-spacer" />
      <div className="workspace-card"><div className="workspace-card-icon"><WandSparkles size={17} /></div><div className="workspace-card-title">Make it happen.</div><div className="workspace-card-copy">Ask once. ActionFlow handles the busywork.</div><button onClick={() => { setView('assistant'); inputRef.current?.focus(); }} className="workspace-card-link">Try a request <ArrowRight size={14} /></button></div>
      <div className="sidebar-footer"><div className="avatar">AF</div><div className="profile-copy"><strong>Demo workspace</strong><span>Local session</span></div><button className="icon-button quiet" onClick={clearDemo} aria-label="Reset demo workspace" title="Reset demo workspace"><Settings2 size={17} /></button></div>
    </aside>

    {sidebarOpen && <button className="mobile-scrim" onClick={() => setSidebarOpen(false)} aria-label="Close navigation overlay" />}
    <main className="main-area">
      <header className="topbar"><div className="breadcrumbs"><button className="mobile-menu icon-button" onClick={() => setSidebarOpen(true)} aria-label="Open navigation"><Command size={19} /></button><span>Workspace</span><span className="crumb-slash">/</span><strong>{navItems.find(item => item.id === view)?.label}</strong></div><div className="topbar-right"><div className={`simulation-pill ${backendConnected ? 'server-connected' : 'browser-mode'}`} title={backendConnected ? 'API connected; state is persisted by the local server' : 'API not connected; using browser-only fallback'}><span className="live-dot" /> {backendConnected ? 'Server connected' : 'Browser fallback'}</div><button className="help-button" onClick={() => { setDraft('What can you do?'); inputRef.current?.focus(); setView('assistant'); }}><CircleHelp size={16} /><span>Help</span></button><div className="top-avatar">AF</div></div></header>
      <div className="page-content">
        <div className="page-heading"><div><div className="eyebrow"><Stars size={14} /> YOUR PERSONAL AI</div><h1>{pageTitle.title}</h1><p>{pageTitle.subtitle}</p></div>{view !== 'assistant' && <button className="primary-button small" onClick={() => { setView('assistant'); window.setTimeout(() => inputRef.current?.focus(), 50); }}><Plus size={16} /> Ask assistant</button>}</div>

        {view === 'assistant' && <div className="dashboard-grid">
          <section className="chat-card">
            <div className="chat-card-top"><div className="assistant-identity"><div className="assistant-avatar"><Bot size={20} /></div><div><strong>ActionFlow assistant</strong><span><span className="status-dot" /> Ready when you are</span></div></div><button className="icon-button quiet" title="New conversation" onClick={() => setMessages([{ id: uid(), role: 'assistant', content: 'Fresh start. What would you like me to take care of?', time: clock() }])}><Plus size={18} /></button></div>
            <div className="chat-scroll" ref={scrollRef}>
              {messages.map(message => <div key={message.id} className={`message-group ${message.role}`}>
                {message.role === 'assistant' && <div className="message-avatar"><Sparkles size={14} /></div>}
                <div className="message-body"><div className="message-bubble">{message.content}</div>{message.actions && message.actions.length > 0 && <div className="execution-card"><div className="execution-head"><CheckCircle2 size={15} /><span>Actions completed</span><span className="execution-count">{message.actions.length}</span></div>{message.actions.map((action, i) => <div className="execution-action" key={`${message.id}-${i}`}><CheckCheck size={14} /><span>{action}</span></div>)}<div className="execution-foot">{backendConnected ? 'Persisted by the ActionFlow API' : 'Saved in this browser only'}</div></div>}<div className="message-meta">{message.time}{message.role === 'assistant' && message.provider && <><span>·</span><span>{message.provider === 'amazon-bedrock' ? 'Amazon Bedrock' : message.provider === 'server-local-agent' ? 'Local agent · server tools' : 'Offline browser mode'}</span></>}</div></div>
                {message.role === 'user' && <div className="user-message-avatar">Y</div>}
              </div>)}
              {processing && <div className="message-group assistant"><div className="message-avatar"><Sparkles size={14} /></div><div className="message-body"><div className="thinking-bubble"><span /><span /><span /> <em>Working through your request</em></div></div></div>}
            </div>
            <div className="composer-wrap"><form className="composer" onSubmit={onSubmit}><textarea ref={inputRef} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={onKeyDown} placeholder="Ask me to get something done…" rows={1} aria-label="Message ActionFlow" disabled={processing} /><div className="composer-actions"><span className="composer-hint"><Sparkles size={13} /> Multi-step actions supported</span><div className="composer-right"><button type="button" className={`icon-button voice-button ${listening ? 'listening' : ''}`} title={listening ? "Stop voice input" : "Speak a request"} aria-label={listening ? "Stop voice input" : "Speak a request"} onClick={toggleVoiceInput} disabled={processing}><Mic size={17} /></button><button type="submit" className="send-button" disabled={!draft.trim() || processing} aria-label="Send message">{processing ? <LoaderCircle className="spin" size={17} /> : <Send size={16} />}</button></div></div></form><div className="privacy-note">ActionFlow simulation · {backendConnected ? 'Workspace stored on your local server' : 'Actions are stored in this browser only'}</div></div>
            {messages.length <= 2 && <div className="quick-prompts"><div className="quick-prompts-heading">A FEW WAYS TO START <span>↘</span></div><div className="prompt-grid">{suggestions.map(item => { const Icon = item.icon; return <button key={item.title} className="prompt-card" onClick={() => void sendMessage(item.prompt)}><span className="prompt-icon"><Icon size={17} /></span><span>{item.title}</span><ArrowUpRight size={15} className="prompt-arrow" /></button>; })}</div></div>}
          </section>
          <aside className="right-rail">
            <section className="summary-card"><div className="rail-card-heading"><div><span className="eyebrow small-eyebrow">AT A GLANCE</span><h3>Your workspace</h3></div><div className="summary-spark"><Sun size={17} /></div></div><div className="stat-grid"><div className="stat-block"><div className="stat-number">{incompleteTasks.length}</div><div className="stat-label">Open tasks</div><div className="stat-icon task-stat"><ListChecks size={15} /></div></div><div className="stat-block"><div className="stat-number">{openReminders.length}</div><div className="stat-label">Reminders</div><div className="stat-icon reminder-stat"><Clock3 size={15} /></div></div><div className="stat-block"><div className="stat-number">{uncheckedItems.length}</div><div className="stat-label">To pick up</div><div className="stat-icon shopping-stat"><ShoppingBasket size={15} /></div></div><div className="stat-block"><div className="stat-number">{activity.length}</div><div className="stat-label">Actions run</div><div className="stat-icon activity-stat"><Activity size={15} /></div></div></div></section>
            <section className="rail-card"><div className="rail-card-heading"><div><h3>Up next</h3><p>Your open tasks</p></div><button className="text-link" onClick={() => setView('tasks')}>View all <ArrowRight size={13} /></button></div>{tasks.length ? renderTasks(true) : <div className="rail-empty"><span className="empty-spark"><CheckCircle2 size={19} /></span><div><strong>Room to breathe.</strong><p>No tasks yet. Add one with a quick message.</p></div></div>}</section>
            <section className="rail-card"><div className="rail-card-heading"><div><h3>Coming up</h3><p>Reminders you’ve set</p></div><button className="text-link" onClick={() => setView('reminders')}>View all <ArrowRight size={13} /></button></div>{reminders.length ? renderReminders(true) : <div className="rail-empty"><span className="empty-spark reminder-empty"><Clock3 size={18} /></span><div><strong>Nothing slipping through.</strong><p>Set a reminder whenever you need it.</p></div></div>}</section>
            <section className="bedrock-note"><div className="bedrock-icon"><Sparkles size={15} /></div><div><strong>Agent-powered by design</strong><p>Optional Amazon Bedrock planning, with a reliable local fallback.</p></div><span className="tiny-status" title="Local fallback available" /></section>
          </aside>
        </div>}

        {view === 'tasks' && <WorkspacePanel icon={<ListChecks size={19} />} title="Tasks" count={tasks.length} description="Capture it, check it off, move on." onAdd={(value) => { const title = value.trim(); if (!title) return; void mutateApi('/api/tasks', { method: 'POST', body: JSON.stringify({ title }) }, () => { setTasks(prev => [{ id: uid(), title, done: false, createdAt: Date.now() }, ...prev]); addActivity('Task created', title, 'task'); }, 'Task added'); }} placeholder="Add a task, e.g. Test the demo">{renderTasks()}</WorkspacePanel>}
        {view === 'reminders' && <WorkspacePanel icon={<Clock3 size={19} />} title="Reminders" count={reminders.length} description="Timed reminders notify you while this app is open after browser permission is enabled." headerAction={<button className="secondary-button notification-button" onClick={() => void enableNotifications()} disabled={notificationPermission === 'unsupported' || notificationPermission === 'granted'}>{notificationPermission === 'granted' ? 'Notifications enabled' : notificationPermission === 'unsupported' ? 'Notifications unsupported' : 'Enable notifications'}</button>} onAdd={(value) => { const parts = value.split('|'); const title = parts[0].trim(); const when = parts[1]?.trim() || 'Today'; if (!title) return; void mutateApi('/api/reminders', { method: 'POST', body: JSON.stringify({ title, when }) }, () => { const scheduledAt = resolveLocalReminderTime(when); setReminders(prev => [{ id: uid(), title, when, scheduledAt, notified: false, createdAt: Date.now(), done: false }, ...prev]); addActivity('Reminder set', `${title} · ${when}`, 'reminder'); }, 'Reminder saved'); }} placeholder="Reminder title | when (optional)">{renderReminders()}</WorkspacePanel>}
        {view === 'shopping' && <WorkspacePanel icon={<ShoppingBasket size={19} />} title="Shopping list" count={shopping.length} description={`${uncheckedItems.length} items left to pick up.`} onAdd={(value) => { const names = value.split(',').map(s => s.trim()).filter(Boolean); if (!names.length) return; void mutateApi('/api/shopping', { method: 'POST', body: JSON.stringify({ items: names }) }, () => { setShopping(prev => [...names.map(name => ({ id: uid(), name, checked: false })), ...prev]); addActivity('Shopping list updated', names.join(', '), 'shopping'); }, 'Items added'); }} placeholder="Add items separated by commas">{renderShopping()}</WorkspacePanel>}
        {view === 'activity' && <section className="full-page-card"><div className="section-card-heading"><div className="section-heading-icon"><Activity size={19} /></div><div><h2>Action history</h2><p>Every action and workspace update is recorded in your active workspace.</p></div><span className="section-count">{activity.length} events</span></div>{renderActivity(50)}</section>}
        <footer className="page-footer"><span>ActionFlow <span className="footer-dot">·</span> Alexa+ experience simulation</span><span>Not an official Amazon or Alexa product</span></footer>
      </div>
    </main>
    {toast && <div className="toast"><CheckCircle2 size={17} />{toast}</div>}
  </div>;
}

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return <div className="empty-state"><div className="empty-state-icon">{icon}</div><strong>{title}</strong><p>{body}</p></div>;
}

function WorkspacePanel({ icon, title, count, description, onAdd, placeholder, children, headerAction }: { icon: React.ReactNode; title: string; count: number; description: string; onAdd: (value: string) => void; placeholder: string; children: React.ReactNode; headerAction?: React.ReactNode }) {
  const [value, setValue] = useState('');
  const submit = (event: FormEvent) => { event.preventDefault(); if (!value.trim()) return; onAdd(value); setValue(''); };
  return <section className="full-page-card"><div className="section-card-heading"><div className="section-heading-icon">{icon}</div><div className="section-title-copy"><h2>{title}</h2><p>{description}</p></div>{headerAction}<span className="section-count">{count} total</span></div><form className="inline-add-form" onSubmit={submit}><input value={value} onChange={e => setValue(e.target.value)} placeholder={placeholder} aria-label={placeholder} /><button className="primary-button" type="submit" disabled={!value.trim()}><Plus size={16} /> Add</button></form><div className="workspace-list-content">{children}</div></section>;
}

export default App;
