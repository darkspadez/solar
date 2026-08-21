/**
 * `crypto.randomUUID` is a secure-context-only API — it vanishes when Solar is
 * browsed over plain HTTP from another machine (e.g. http://LAN-IP:3000) and
 * any UI calling it throws inside a React render. `getRandomValues` is NOT
 * restricted, so fall back to a hand-built v4 UUID from it.
 */
export function newId(): string {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}
	const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
	bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
	const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
	return (
		hex.slice(0, 4).join("") +
		"-" +
		hex.slice(4, 6).join("") +
		"-" +
		hex.slice(6, 8).join("") +
		"-" +
		hex.slice(8, 10).join("") +
		"-" +
		hex.slice(10, 16).join("")
	);
}
