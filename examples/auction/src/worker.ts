import { withCallerIdentity } from "@actor-kit/worker";
import { Auction } from "./auction";

export { Auction };

interface Env {
  AUCTION: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(clientHTML(), { headers: { "Content-Type": "text/html" } });
    }

    if (url.pathname.startsWith("/api/auction/")) {
      const auctionId = url.pathname.split("/")[3] ?? "default";
      const item = url.searchParams.get("item") ?? "Mystery Item";

      // Authenticate the caller.
      // PRODUCTION: validate a session cookie, OAuth token, or similar credential here.
      // This demo uses a query param for simplicity — NOT safe for production.
      // CORS/Origin validation is handled at the Worker level (e.g., Hono cors() middleware), not inside the actor.
      const callerId = url.searchParams.get("user") ?? `bidder-${crypto.randomUUID().slice(0, 6)}`;

      const id = env.AUCTION.idFromName(auctionId);
      const stub = env.AUCTION.get(id);
      await stub.spawn({ actorId: auctionId, caller: "system", callerType: "service", input: { item } });

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
  <title>Actor Kit Auction</title>
  <style>
    body { font-family: system-ui; max-width: 600px; margin: 40px auto; padding: 0 20px; }
    h1 { font-size: 1.5rem; }
    #item { font-size: 1.2rem; color: #333; margin: 8px 0; }
    #bid-info { font-size: 2rem; margin: 16px 0; text-align: center; }
    #bid-form { display: flex; gap: 8px; margin: 16px 0; }
    #bid-form input { flex: 1; padding: 8px; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; }
    #bid-form button { padding: 8px 16px; cursor: pointer; border: 1px solid #ccc; border-radius: 4px; }
    #winner { font-size: 1.2rem; color: #080; margin: 16px 0; padding: 12px; background: #efe; border-radius: 8px; display: none; }
    #status { color: #888; font-size: 0.85rem; margin-top: 16px; }
    .closed #bid-form { display: none; }
  </style>
</head>
<body>
  <h1>Auction</h1>
  <div id="item"></div>
  <div id="bid-info">
    <div>Highest Bid: $<span id="highest-bid">0</span></div>
    <div style="font-size: 0.9rem; color: #888;"><span id="bid-count">0</span> bids</div>
  </div>
  <div id="bid-form">
    <input type="number" id="bid-input" placeholder="Your bid amount" min="1" />
    <button id="bid-btn">Place Bid</button>
  </div>
  <div id="winner"></div>
  <div id="status">Connecting...</div>

  <script>
    let ws;

    async function init() {
      const params = new URLSearchParams(location.search);
      const auction = params.get('auction') || 'default';
      const callerId = params.get('user') || 'bidder-' + crypto.randomUUID().slice(0, 6);
      const item = params.get('item') || 'Mystery Item';

      // Connect WebSocket — Worker stamps identity via withCallerIdentity
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(
        protocol + '//' + location.host + '/api/auction/' + auction + '?item=' + encodeURIComponent(item) + '&user=' + encodeURIComponent(callerId)
      );

      ws.addEventListener('open', () => {
        document.getElementById('status').textContent = 'Connected as ' + callerId;
      });

      ws.addEventListener('message', (event) => {
        if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'snapshot') updateUI(msg.data);
          } catch {}
        }
      });

      ws.addEventListener('close', () => {
        document.getElementById('status').textContent = 'Disconnected';
      });
    }

    function updateUI(data) {
      document.getElementById('item').textContent = 'Item: ' + data.item;
      document.getElementById('highest-bid').textContent = data.highestBid;
      document.getElementById('bid-count').textContent = data.bidCount;

      if (data.closed) {
        document.body.classList.add('closed');
        const winner = document.getElementById('winner');
        winner.style.display = 'block';
        winner.textContent = 'Auction closed! Winner: ' + data.winner + ' with $' + data.highestBid;
      }
    }

    document.getElementById('bid-btn').addEventListener('click', () => {
      const input = document.getElementById('bid-input');
      const amount = parseInt(input.value, 10);
      if (amount > 0 && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'BID', amount }));
        input.value = '';
      }
    });

    init();
  </script>
</body>
</html>`;
}
