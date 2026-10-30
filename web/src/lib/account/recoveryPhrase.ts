// The recovery phrase: twelve words a person writes down, from which their
// app derives an Ed25519 key -- the key their recovery plan names. The
// words never leave the device and are never stored; only the key's public
// half is published. With the words, a new device signs for the account
// (`account_types::phrase_message`), and validation checks that signature.
//
// The words are BIP-39's, in the person's language where BIP-39 has a list
// for it; a phrase in any of those lists is recognised on entry. The key is
// derived from the phrase's BIP-39 seed through HKDF, under HandShake's own
// label, so the same words used anywhere else never give the same key.
import { ed25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as czech } from "@scure/bip39/wordlists/czech";
import { wordlist as english } from "@scure/bip39/wordlists/english";
import { wordlist as french } from "@scure/bip39/wordlists/french";
import { wordlist as italian } from "@scure/bip39/wordlists/italian";
import { wordlist as japanese } from "@scure/bip39/wordlists/japanese";
import { wordlist as korean } from "@scure/bip39/wordlists/korean";
import { wordlist as portuguese } from "@scure/bip39/wordlists/portuguese";
import { wordlist as simplifiedChinese } from "@scure/bip39/wordlists/simplified-chinese";
import { wordlist as spanish } from "@scure/bip39/wordlists/spanish";
import { wordlist as traditionalChinese } from "@scure/bip39/wordlists/traditional-chinese";
import { dhtLocationFrom32 } from "@holochain/client";

/// BIP-39's lists, by the language tag they serve.
const LISTS: Record<string, string[]> = {
  en: english,
  es: spanish,
  fr: french,
  it: italian,
  pt: portuguese,
  cs: czech,
  ja: japanese,
  ko: korean,
  "zh-CN": simplifiedChinese,
  "zh-TW": traditionalChinese,
};

/// 128 bits: twelve words.
const STRENGTH = 128;
const KEY_LABEL = new TextEncoder().encode("handshake-recovery-key:v1");
const PHRASE_LABEL = new TextEncoder().encode("handshake-recovery:v1:");
/// Holochain's prefix for an agent key.
const AGENT_PREFIX = [0x84, 0x20, 0x24];

/// The word list for `language` (a BCP 47 tag), falling back to English.
function listFor(language: string): string[] {
  if (language.startsWith("zh")) return /TW|HK|MO|Hant/i.test(language) ? traditionalChinese : simplifiedChinese;
  return LISTS[language.split("-")[0]] ?? english;
}

/// Words are joined by a space, or in Japanese, by an ideographic space.
const separator = (list: string[]) => (list === japanese ? "　" : " ");

/// A new phrase, in the person's language where BIP-39 has a list for it.
export function newPhrase(language: string = navigator.language): string[] {
  const list = listFor(language);
  return generateMnemonic(list, STRENGTH).split(separator(list));
}

/// The phrase `text` spells, tidied -- or `null` if it isn't twelve words of
/// one list with a valid checksum.
export function readPhrase(text: string): string[] | null {
  const words = text.normalize("NFKD").trim().toLowerCase().split(/[\s　]+/).filter(Boolean);
  if (words.length !== STRENGTH / 128 * 12) return null;
  for (const list of Object.values(LISTS)) {
    const normalized = list.map((w) => w.normalize("NFKD"));
    if (words.every((w) => normalized.includes(w))) {
      const phrase = words.map((w) => list[normalized.indexOf(w)]);
      if (validateMnemonic(phrase.join(separator(list)), list)) return phrase;
    }
  }
  return null;
}

/// The phrase's key: its private half, kept only while it's used, and its
/// public half as an agent key -- the form the network carries keys in.
export interface PhraseKey {
  publicKey: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
}

export function phraseKey(phrase: string[]): PhraseKey {
  const list = Object.values(LISTS).find((l) => phrase.every((w) => l.includes(w))) ?? english;
  const seed = mnemonicToSeedSync(phrase.join(separator(list)));
  const secret = hkdf(sha256, seed, KEY_LABEL, new Uint8Array(), 32);
  const raw = ed25519.getPublicKey(secret);
  return {
    publicKey: new Uint8Array([...AGENT_PREFIX, ...raw, ...dhtLocationFrom32(raw)]),
    sign: (message) => ed25519.sign(message, secret),
  };
}

/// What the phrase's key signs to recover `predecessor` onto `successor`,
/// as the account stood at `head` -- `account_types::phrase_message`.
export function phraseMessage(predecessor: Uint8Array, successor: Uint8Array, head: Uint8Array): Uint8Array {
  return new Uint8Array([...PHRASE_LABEL, ...predecessor, 58, ...successor, 58, ...head]);
}
