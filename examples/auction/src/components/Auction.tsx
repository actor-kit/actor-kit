import { useState } from "react";

export function AuctionDisplay({
  item,
  bidCount,
  highestBid,
  closed,
  winner,
  onBid,
}: {
  item: string;
  bidCount: number;
  highestBid: number;
  closed: boolean;
  winner: string | null;
  onBid: (amount: number) => void;
}) {
  const [bidAmount, setBidAmount] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const amount = parseInt(bidAmount, 10);
    if (amount > 0) {
      onBid(amount);
      setBidAmount("");
    }
  }

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h2
        id="item"
        className="text-2xl font-semibold text-[var(--sea-ink)]"
      >
        {item}
      </h2>

      <div className="text-7xl font-bold tabular-nums text-[var(--sea-ink)]">
        $<span id="highest-bid">{highestBid}</span>
      </div>

      <p className="text-sm text-[var(--sea-ink-soft)]">
        <span id="bid-count">{bidCount}</span> {bidCount === 1 ? "bid" : "bids"}
      </p>

      {!closed ? (
        <form
          id="bid-form"
          className="flex w-full gap-3"
          onSubmit={handleSubmit}
        >
          <input
            id="bid-input"
            type="number"
            min="1"
            value={bidAmount}
            onChange={(e) => setBidAmount(e.target.value)}
            placeholder="Your bid amount"
            className="flex-1 rounded-2xl border border-gray-200 px-4 py-3 text-base outline-none transition focus:border-[var(--lagoon-deep)] focus:ring-1 focus:ring-[var(--lagoon-deep)]"
          />
          <button
            id="bid-btn"
            type="submit"
            className="rounded-2xl border border-[rgba(26,138,122,0.3)] bg-[rgba(26,138,122,0.1)] px-6 py-3 text-base font-medium text-[var(--lagoon-deep)] transition hover:-translate-y-0.5 hover:bg-[rgba(26,138,122,0.2)]"
          >
            Place Bid
          </button>
        </form>
      ) : null}

      {closed && winner ? (
        <div
          id="winner"
          className="w-full rounded-2xl border border-emerald-200 bg-emerald-50 px-6 py-4 text-center text-lg font-semibold text-emerald-800"
        >
          Auction closed! Winner: {winner} with ${highestBid}
        </div>
      ) : null}
    </div>
  );
}
