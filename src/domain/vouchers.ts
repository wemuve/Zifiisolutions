import { randomInt } from "node:crypto";

// No 0/O, 1/I/L or 5/S, so codes read cleanly off a printed card or a phone screen.
const ALPHABET = "ABCDEFGHJKMNPQRTUVWXYZ2346789";
export const VOUCHER_LENGTH = 10;

export function generateVoucherCode(): string {
  let code = "";
  for (let i = 0; i < VOUCHER_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

// Guests type codes in any case and often add spaces or dashes.
export function normalizeVoucherCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "");
}

export function looksLikeVoucherCode(input: string): boolean {
  const code = normalizeVoucherCode(input);
  return code.length === VOUCHER_LENGTH && [...code].every((c) => ALPHABET.includes(c));
}
