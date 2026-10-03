// Plain base64 <-> bytes, used wherever binary data (a connection token, an
// agent pubkey, a WebAuthn credential ID) needs to travel as text -- into
// localStorage, or through an API that only accepts strings/buffers, not
// raw Uint8Arrays. One implementation shared by the two call sites that
// each used to carry their own copy (one keyed off Uint8Array, one off
// ArrayBuffer -- the same bytes, just a different view type).
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
