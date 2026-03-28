import { withCallerIdentity } from "@actor-kit/worker";
import { TodoList } from "./todo";

export { TodoList };

interface Env {
  TODO_LIST: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(clientHTML(), { headers: { "Content-Type": "text/html" } });
    }

    if (url.pathname.startsWith("/api/todo-list/")) {
      const listId = url.pathname.split("/")[3] ?? "default";

      // Authenticate the caller.
      // PRODUCTION: validate a session cookie, OAuth token, or similar credential here.
      // This demo uses a query param for simplicity — NOT safe for production.
      // Origin validation (DO-level) provides CSRF defense for deployed apps.
      const callerId = url.searchParams.get("callerId") ?? `user-${crypto.randomUUID().slice(0, 8)}`;

      const id = env.TODO_LIST.idFromName(listId);
      const stub = env.TODO_LIST.get(id);

      // Spawn with creator from query param (or first caller)
      const creator = url.searchParams.get("creator") ?? callerId;
      await stub.spawn({ actorId: listId, caller: creator, callerType: "user", input: { creator } });

      const stamped = withCallerIdentity(request, { callerId, callerType: "user" });
      return stub.fetch(stamped);
    }

    return new Response("Not found", { status: 404 });
  },
};

function clientHTML(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Actor Kit Todo List</title>
  <style>
    body { font-family: system-ui; max-width: 600px; margin: 40px auto; padding: 0 20px; }
    h1 { font-size: 1.5rem; }
    #add-form { display: flex; gap: 8px; margin: 16px 0; }
    #add-form input { flex: 1; padding: 8px; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; }
    #add-form button { padding: 8px 16px; font-size: 1rem; cursor: pointer; border: 1px solid #ccc; border-radius: 4px; }
    .todo { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid #eee; }
    .todo.done span { text-decoration: line-through; color: #999; }
    .todo input[type="checkbox"] { width: 18px; height: 18px; cursor: pointer; }
    .todo button { background: none; border: none; color: #c00; cursor: pointer; font-size: 1.2rem; }
    #status { color: #888; font-size: 0.85rem; margin-top: 16px; }
    #role-info { color: #666; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>Todo List</h1>
  <div id="role-info"></div>
  <div id="add-form" style="display:none;">
    <input type="text" id="todo-input" placeholder="Add a todo..." />
    <button id="add-btn">Add</button>
  </div>
  <div id="todos"></div>
  <div id="viewer-info" style="display:none;"></div>
  <div id="status">Connecting...</div>

  <script>
    let ws;
    let currentView;
    let currentRole;

    async function init() {
      const params = new URLSearchParams(location.search);
      const listId = params.get('list') || 'default';
      const callerId = params.get('user') || 'user-' + crypto.randomUUID().slice(0, 8);

      document.getElementById('status').textContent = 'Connecting as ' + callerId + '...';

      // Connect WebSocket — Worker stamps identity via withCallerIdentity
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = protocol + '//' + location.host + '/api/todo-list/' + listId + '?callerId=' + encodeURIComponent(callerId) + '&creator=' + encodeURIComponent(callerId);
      ws = new WebSocket(wsUrl);

      ws.addEventListener('open', () => {
        document.getElementById('status').textContent = 'Connected as ' + callerId;
      });

      ws.addEventListener('message', (event) => {
        if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'snapshot') {
              currentView = msg.data;
              currentRole = msg.role;
              updateUI();
            }
          } catch {}
        }
      });

      ws.addEventListener('close', () => {
        document.getElementById('status').textContent = 'Disconnected';
      });
    }

    function updateUI() {
      if (!currentView) return;

      const roleInfo = document.getElementById('role-info');
      roleInfo.textContent = 'Role: ' + currentRole;

      if (currentRole === 'viewer') {
        document.getElementById('add-form').style.display = 'none';
        document.getElementById('todos').innerHTML = '';
        const info = document.getElementById('viewer-info');
        info.style.display = 'block';
        info.textContent = currentView.todoCount + ' todos (' + currentView.doneCount + ' done)';
        return;
      }

      document.getElementById('add-form').style.display = 'flex';
      document.getElementById('viewer-info').style.display = 'none';

      const todosEl = document.getElementById('todos');
      todosEl.innerHTML = '';
      for (const todo of currentView.todos || []) {
        const div = document.createElement('div');
        div.className = 'todo' + (todo.done ? ' done' : '');

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = todo.done;
        cb.addEventListener('change', () => send('TOGGLE', { id: todo.id }));

        const span = document.createElement('span');
        span.textContent = todo.text;

        div.appendChild(cb);
        div.appendChild(span);

        if (currentRole === 'owner') {
          const btn = document.createElement('button');
          btn.textContent = '×';
          btn.title = 'Delete';
          btn.addEventListener('click', () => send('DELETE_TODO', { id: todo.id }));
          div.appendChild(btn);
        }

        todosEl.appendChild(div);
      }
    }

    function send(type, payload) {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type, ...payload }));
      }
    }

    document.getElementById('add-btn').addEventListener('click', () => {
      const input = document.getElementById('todo-input');
      const text = input.value.trim();
      if (text) {
        send('ADD_TODO', { text });
        input.value = '';
      }
    });

    document.getElementById('todo-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('add-btn').click();
    });

    init();
  </script>
</body>
</html>`;
}
