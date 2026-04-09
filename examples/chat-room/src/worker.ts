import { withCallerIdentity } from "@actor-kit/worker";
import { ChatRoom } from "./chat.server";

export { ChatRoom };

interface Env {
  CHAT_ROOM: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const { callerId, setCookie } = resolveCaller(request);
      const headers = new Headers({ "Content-Type": "text/html" });
      if (setCookie) headers.set("Set-Cookie", setCookie);
      return new Response(clientHTML(callerId), { headers });
    }

    if (url.pathname.startsWith("/api/chat-room/")) {
      const roomId = url.pathname.split("/")[3] ?? "general";

      // Authenticate the caller via session cookie.
      // PRODUCTION: validate a signed session cookie, OAuth token, or similar credential.
      // CORS/Origin validation is handled at the Worker level, not inside the actor.
      const { callerId } = resolveCaller(request);

      const id = env.CHAT_ROOM.idFromName(roomId);
      const stub = env.CHAT_ROOM.get(id);
      await stub.spawn({ actorId: roomId, caller: "system", callerType: "service", input: {} });

      const stamped = withCallerIdentity(request, { callerId, callerType: "user" });
      return stub.fetch(stamped);
    }

    return new Response("Not found", { status: 404 });
  },
};

function resolveCaller(request: Request): { callerId: string; setCookie: string | null } {
  const cookieHeader = request.headers.get("Cookie") ?? "";
  const match = cookieHeader.match(/(?:^|;\s*)caller_id=([^;]+)/);
  if (match?.[1]) return { callerId: decodeURIComponent(match[1]), setCookie: null };
  const callerId = `anon-${crypto.randomUUID().slice(0, 6)}`;
  const setCookie = `caller_id=${encodeURIComponent(callerId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
  return { callerId, setCookie };
}

function clientHTML(callerId: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Actor Kit Chat</title>
  <style>
    body { font-family: system-ui; max-width: 600px; margin: 40px auto; padding: 0 20px; }
    #messages { border: 1px solid #ddd; border-radius: 8px; padding: 12px; height: 400px; overflow-y: auto; margin: 16px 0; }
    .msg { margin: 4px 0; }
    .msg .author { font-weight: bold; color: #333; }
    .msg .text { color: #555; }
    #send-form { display: flex; gap: 8px; }
    #send-form input { flex: 1; padding: 8px; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; }
    #send-form button { padding: 8px 16px; cursor: pointer; border: 1px solid #ccc; border-radius: 4px; }
    #info { color: #888; font-size: 0.85rem; margin-top: 8px; }
  </style>
</head>
<body>
  <h1>Chat Room</h1>
  <div id="info">Connecting...</div>
  <div id="messages"></div>
  <div id="send-form">
    <input type="text" id="msg-input" placeholder="Type a message..." />
    <button id="send-btn">Send</button>
  </div>

  <script>
    let ws;

    async function init() {
      const params = new URLSearchParams(location.search);
      const room = params.get('room') || 'general';
      const callerId = ${JSON.stringify(callerId)};

      // Connect WebSocket — session cookie is sent automatically; worker stamps identity via withCallerIdentity
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + location.host + '/api/chat-room/' + room);

      ws.addEventListener('open', () => {
        document.getElementById('info').textContent = callerId + ' in #' + room;
      });

      ws.addEventListener('message', (event) => {
        if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'snapshot') {
              renderMessages(msg.data.messages || []);
              document.getElementById('info').textContent = callerId + ' in #' + room + ' (' + (msg.data.onlineCount || 0) + ' online)';
            }
          } catch {}
        }
      });

      ws.addEventListener('close', () => {
        document.getElementById('info').textContent = 'Disconnected';
      });
    }

    function renderMessages(messages) {
      const el = document.getElementById('messages');
      el.innerHTML = '';
      for (const m of messages) {
        const div = document.createElement('div');
        div.className = 'msg';
        div.innerHTML = '<span class="author">' + escapeHtml(m.author) + ':</span> <span class="text">' + escapeHtml(m.text) + '</span>';
        el.appendChild(div);
      }
      el.scrollTop = el.scrollHeight;
    }

    function escapeHtml(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function send() {
      const input = document.getElementById('msg-input');
      const text = input.value.trim();
      if (text && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'SEND_MESSAGE', text }));
        input.value = '';
      }
    }

    document.getElementById('send-btn').addEventListener('click', send);
    document.getElementById('msg-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send();
    });

    init();
  </script>
</body>
</html>`;
}
