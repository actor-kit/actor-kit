import { createAccessToken } from "@actor-kit/worker";
import { Counter } from "./counter";

export { Counter };

interface Env {
  ACTOR_KIT_SECRET: string;
  COUNTER: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Serve the client page
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(clientHTML(env), {
        headers: { "Content-Type": "text/html" },
      });
    }

    // Create access token for WebSocket auth
    if (url.pathname === "/api/token") {
      const actorId = url.searchParams.get("actorId") ?? "default";
      const callerId = url.searchParams.get("callerId") ?? `user-${crypto.randomUUID().slice(0, 8)}`;
      const token = await createAccessToken({
        actorType: "counter",
        actorId,
        callerId,
        callerType: "user",
        secret: env.ACTOR_KIT_SECRET,
      });
      return Response.json({ token, callerId, actorId });
    }

    // Route WebSocket connections to the Counter DO
    if (url.pathname.startsWith("/api/counter/")) {
      const actorId = url.pathname.split("/")[3] ?? "default";
      const id = env.COUNTER.idFromName(actorId);
      const stub = env.COUNTER.get(id);

      // Spawn idempotently
      await stub.spawn({ actorId, caller: "system", callerType: "service", input: {} });

      // Forward the request to the DO
      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};

function clientHTML(env: Env): string {
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
      // Get access token
      const actorId = new URLSearchParams(location.search).get('id') || 'default';
      const res = await fetch('/api/token?actorId=' + actorId);
      const { token, callerId } = await res.json();
      document.getElementById('status').textContent = 'Connecting as ' + callerId + '...';

      // Connect WebSocket
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + location.host + '/api/counter/' + actorId, ['token.' + token]);

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
