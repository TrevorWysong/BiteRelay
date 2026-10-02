// Signal-only chat between an order's two active parties -- see
// dispatch_coordinator::chat's doc comment for why this is deliberately
// not persisted on the DHT. Consequence of that design, named honestly:
// history is in-memory only and does not survive a page reload or
// switching away from this screen.
import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { sendChatMessage } from "../holochain/zomes/dispatch";
import { onLocalSignal, myAgentPubKey } from "../holochain/client";
import { bytesEqual, bytesToHex } from "../holochain/decode";
import { shortAgentId } from "../lib/format";
import type { ActionHash } from "../holochain/types";
import { Button } from "./ui";

interface ChatLine {
  from: Uint8Array;
  text: string;
  sentAt: number;
}

export function ChatPanel({ orderRef, title = "Chat" }: { orderRef: ActionHash; title?: string }) {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const me = myAgentPubKey();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = onLocalSignal((signal) => {
      if (!("ChatMessage" in signal)) return;
      const msg = signal.ChatMessage;
      if (!bytesEqual(msg.order_ref, orderRef)) return;
      setLines((prev) => [...prev, { from: msg.from, text: msg.text, sentAt: msg.sent_at }]);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytesToHex(orderRef)]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines.length]);

  async function send() {
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    try {
      await sendChatMessage(orderRef, text);
      // send_remote_signal only reaches the *other* party -- append our own
      // message locally so it shows up immediately for the sender too.
      setLines((prev) => [...prev, { from: me, text, sentAt: Date.now() * 1000 }]);
      setDraft("");
    } catch {
      // Best-effort, same posture as every other fire-and-forget signal in
      // this app -- a dropped chat message isn't worth surfacing an error
      // banner over.
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-3">
      <p className="text-xs font-bold uppercase tracking-wide text-ink-400">{title}</p>
      <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto">
        {lines.length === 0 && <p className="text-xs text-ink-400">No messages yet.</p>}
        {lines.map((line, i) => {
          const mine = bytesEqual(line.from, me);
          return (
            <div key={i} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[80%] rounded-xl px-3 py-1.5 text-xs ${mine ? "bg-relay-500 text-white" : "bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-200"}`}>
                {!mine && <p className="mb-0.5 text-[10px] opacity-70">{shortAgentId(line.from)}</p>}
                {line.text}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Message..."
          className="flex-1 rounded-full border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-1.5 text-xs outline-none focus:border-relay-400"
        />
        <Button className="px-3 py-1.5" loading={sending} onClick={send}>
          <Send size={13} />
        </Button>
      </div>
    </div>
  );
}
