// A device's account code -- its key, as a QR code and as text -- and the
// reader for one: the camera, or the code pasted. What a new device shows
// its old one to be handed the account, and what a person shows someone to
// make them a guardian or to be vouched for. Both show the key's
// fingerprint, which two people compare aloud before anything is trusted.
import { useCallback, useState } from "react";
import { Camera, Check, Copy, Keyboard } from "lucide-react";
import type { AgentPubKey } from "../holochain/types";
import { accountCode, keyFingerprint, readAccountCode } from "../lib/accountMove";
import { QrSvg } from "./HandoverCode";
import { QrScanner } from "./QrScanner";
import { Button, Input } from "./ui";

export function AccountCode({ agent, note }: { agent: AgentPubKey; note: string }) {
  const code = accountCode(agent);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // No clipboard here: the code is on screen to select by hand.
    }
  }

  return (
    <div className="flex flex-col items-center text-center">
      {/* Always on white: scanners need the contrast, dark mode or not. */}
      <div className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-ink-100">
        <QrSvg text={code} size={188} />
      </div>
      <p className="mt-3 text-[11px] font-bold uppercase tracking-[0.12em] text-ink-400">Fingerprint</p>
      <p className="font-mono text-lg font-black tracking-widest text-ink-900 dark:text-ink-50">{keyFingerprint(agent)}</p>
      <p className="mt-2 max-w-xs text-xs leading-relaxed text-ink-500 dark:text-ink-400">{note}</p>
      <button type="button" onClick={copy} className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-relay-600 hover:underline dark:text-relay-400">
        {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy the code instead"}
      </button>
    </div>
  );
}

/// Reads an account code -- scanned, or pasted -- and hands over its key.
export function AccountCodeReader({ onKey, prompt }: { onKey: (key: AgentPubKey) => void; prompt: string }) {
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const onScan = useCallback(
    (scanned: string) => {
      const key = readAccountCode(scanned);
      if (key) onKey(key);
      else setProblem("That isn't a Relay account code.");
    },
    [onKey],
  );

  function submit() {
    const key = readAccountCode(text);
    if (key) onKey(key);
    else setProblem("That isn't a Relay account code. Copy it again from the other screen.");
  }

  return (
    <div>
      {typing ? (
        <div className="flex flex-col gap-2">
          <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="relay-account:uhCAk…" className="font-mono text-xs" />
          <Button disabled={!text.trim()} onClick={submit}>
            Continue
          </Button>
        </div>
      ) : (
        <QrScanner onScan={onScan} prompt={prompt} />
      )}
      {problem && <p className="mt-2 text-center text-xs text-red-600 dark:text-red-400">{problem}</p>}
      <button
        type="button"
        onClick={() => {
          setTyping((t) => !t);
          setProblem(null);
        }}
        className="mx-auto mt-3 flex items-center gap-1.5 text-xs font-semibold text-ink-500 hover:text-ink-700 dark:hover:text-ink-300"
      >
        {typing ? <Camera size={13} /> : <Keyboard size={13} />} {typing ? "Scan it instead" : "Paste the code instead"}
      </button>
    </div>
  );
}
