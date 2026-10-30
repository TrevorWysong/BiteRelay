// Codes one device shows another -- as a QR code and as text -- and the
// reader for one: the camera, or the code pasted. Each shows a fingerprint,
// which two people compare aloud (or one person, on both screens) before
// anything is trusted. An account code is a device's key: what a person
// shows someone to make them a guardian or to be vouched for. Moving an
// account to a new phone has codes of its own (`lib/account/deviceMove.ts`).
import { useState } from "react";
import { Camera, Check, Copy, Keyboard } from "lucide-react";
import type { AgentPubKey } from "../holochain/types";
import { accountCode, keyFingerprint, readAccountCode } from "../lib/account/accountMove";
import { QrSvg } from "./HandoverCode";
import { QrScanner } from "./QrScanner";
import { Button, Input } from "./ui";
import { useT } from "../i18n";

/// `code`, to scan or copy, with its fingerprint.
export function CodeCard({ code, fingerprint, note }: { code: string; fingerprint: string; note: string }) {
  const t = useT();
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
      <p className="mt-3 text-[11px] font-bold uppercase tracking-[0.12em] text-ink-400">{t("code.fingerprint")}</p>
      <p className="font-mono text-lg font-black tracking-widest text-ink-900 dark:text-ink-50">{fingerprint}</p>
      <p className="mt-2 max-w-xs text-xs leading-relaxed text-ink-500 dark:text-ink-400">{note}</p>
      <button type="button" onClick={copy} className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-handshake-600 hover:underline dark:text-handshake-400">
        {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? t("code.copied") : t("code.copy")}
      </button>
    </div>
  );
}

/// Reads a code -- scanned, or pasted -- that `accepts`, and hands it on;
/// anything else is refused with `refusal`.
export function CodeReader({ accepts, onCode, prompt, refusal, placeholder }: { accepts: (code: string) => boolean; onCode: (code: string) => void; prompt: string; refusal: string; placeholder: string }) {
  const t = useT();
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  function take(code: string) {
    if (accepts(code)) onCode(code.trim());
    else setProblem(refusal);
  }

  return (
    <div>
      {typing ? (
        <div className="flex flex-col gap-2">
          <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} className="font-mono text-xs" />
          <Button disabled={!text.trim()} onClick={() => take(text)}>
            {t("common.continue")}
          </Button>
        </div>
      ) : (
        <QrScanner onScan={take} prompt={prompt} />
      )}
      {problem && <p className="mt-2 text-center text-xs text-red-600 dark:text-red-400">{problem}</p>}
      <button
        type="button"
        onClick={() => {
          setTyping((v) => !v);
          setProblem(null);
        }}
        className="mx-auto mt-3 flex items-center gap-1.5 text-xs font-semibold text-ink-500 hover:text-ink-700 dark:hover:text-ink-300"
      >
        {typing ? <Camera size={13} /> : <Keyboard size={13} />} {typing ? t("code.scanInstead") : t("code.pasteInstead")}
      </button>
    </div>
  );
}

/// A device's account code.
export function AccountCode({ agent, note }: { agent: AgentPubKey; note: string }) {
  return <CodeCard code={accountCode(agent)} fingerprint={keyFingerprint(agent)} note={note} />;
}

/// Reads an account code, and hands over its key.
export function AccountCodeReader({ onKey, prompt }: { onKey: (key: AgentPubKey) => void; prompt: string }) {
  const t = useT();
  return <CodeReader accepts={(code) => readAccountCode(code) !== null} onCode={(code) => onKey(readAccountCode(code)!)} prompt={prompt} refusal={t("code.notAccount")} placeholder="handshake-account:uhCAk…" />;
}
