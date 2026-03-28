import { withCallerIdentity } from "@actor-kit/worker";
import { Counter } from "./counter";

export { Counter };

interface Env {
  COUNTER: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Serve the client page
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(clientHTML(), {
        headers: { "Content-Type": "text/html" },
      });
    }

    // Route WebSocket connections to the Counter DO
    if (url.pathname.startsWith("/api/counter/")) {
      const actorId = url.pathname.split("/")[3] ?? "default";

      // Authenticate the caller.
      // PRODUCTION: validate a session cookie, OAuth token, or similar credential here.
      // This demo uses a query param for simplicity — NOT safe for production.
      // Origin validation (DO-level) provides CSRF defense for deployed apps.
      const callerId = url.searchParams.get("callerId") ?? `user-${crypto.randomUUID().slice(0, 8)}`;

      const id = env.COUNTER.idFromName(actorId);
      const stub = env.COUNTER.get(id);

      // Spawn idempotently
      await stub.spawn({ actorId, caller: "system", callerType: "service", input: {} });

      // Stamp verified identity and forward to DO
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
  <title>Actor Kit Counter</title>
  <style>
    body { font-family: system-ui; max-width: 600px; margin: 50px auto; text-align: center; }
    #count { font-size: 4rem; margin: 20px 0; }
    button { font-size: 1.2rem; padding: 10px 24px; margin: 5px; cursor: pointer; border: 1px solid #ccc; border-radius: 6px; }
    button:hover { background: #f0f0f0; }
    #status { color: #888; font-size: 0.9rem; margin-top: 20px; }
    #last-updated { color: #666; font-size: 0.9rem; }
  </style>
</head>
<body>
  <h1>Actor Kit Counter</h1>
  <div id="count">—</div>
  <div id="last-updated"></div>
  <div>
    <button id="decrement">−</button>
    <button id="increment">+</button>
  </div>
  <div id="status">Connecting...</div>

  <script>
    let ws;
    let currentView;

    async function init() {
      const params = new URLSearchParams(location.search);
      const actorId = params.get('id') || 'default';
      const callerId = params.get('user') || 'user-' + crypto.randomUUID().slice(0, 8);
      document.getElementById('status').textContent = 'Connecting as ' + callerId + '...';

      // Connect WebSocket — Worker stamps identity via withCallerIdentity
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + location.host + '/api/counter/' + actorId + '?callerId=' + encodeURIComponent(callerId));

      ws.addEventListener('open', () => {
        document.getElementById('status').textContent = 'Connected as ' + callerId;
      });

      ws.addEventListener('message', (event) => {
        // For now, handle JSON snapshots (binary handling would need the decoder)
        if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'snapshot') {
              currentView = msg.data;
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
      document.getElementById('count').textContent = currentView.count;
      const lastBy = currentView.lastUpdatedBy;
      document.getElementById('last-updated').textContent = lastBy ? 'Last updated by: ' + lastBy : '';
    }

    function send(type) {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type }));
      }
    }

    document.getElementById('increment').addEventListener('click', () => send('INCREMENT'));
    document.getElementById('decrement').addEventListener('click', () => send('DECREMENT'));

    init();
  </script>
</body>
</html>`;
}
