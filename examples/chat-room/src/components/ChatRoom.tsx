export function ChatRoomDisplay({
  messages,
  onlineCount,
  currentUser,
  inputValue,
  onInputChange,
  onSend,
}: {
  messages: { id: string; author: string; text: string }[];
  onlineCount: number;
  currentUser: string;
  inputValue: string;
  onInputChange: (value: string) => void;
  onSend: (text: string) => void;
}) {
  const handleSubmit = () => {
    const text = inputValue.trim();
    if (text) {
      onSend(text);
    }
  };

  return (
    <div className="flex w-full flex-col gap-4">
      <div
        id="info"
        className="text-sm text-[var(--sea-ink-soft)]"
      >
        {currentUser} &mdash; {onlineCount} online
      </div>

      <div
        id="messages"
        className="flex h-96 flex-col gap-2 overflow-y-auto rounded-2xl border border-gray-200 p-4"
      >
        {messages.length === 0 ? (
          <p className="text-center text-sm text-[var(--sea-ink-soft)]">
            No messages yet. Say something!
          </p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className="msg flex gap-2">
              <span className="author shrink-0 text-sm font-semibold text-[var(--sea-ink)]">
                {m.author}:
              </span>
              <span className="text text-sm text-[var(--sea-ink-soft)]">
                {m.text}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="flex gap-3">
        <input
          id="msg-input"
          type="text"
          className="flex-1 rounded-2xl border border-gray-200 px-4 py-3 text-sm outline-none transition focus:border-[var(--lagoon-deep)]"
          placeholder="Type a message..."
          value={inputValue}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
          }}
        />
        <button
          id="send-btn"
          className="rounded-2xl border border-[rgba(26,138,122,0.3)] bg-[rgba(26,138,122,0.1)] px-6 py-3 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:-translate-y-0.5 hover:bg-[rgba(26,138,122,0.2)] disabled:opacity-50"
          onClick={handleSubmit}
          disabled={!inputValue.trim()}
          type="button"
        >
          Send
        </button>
      </div>
    </div>
  );
}
