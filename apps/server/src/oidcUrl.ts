const OIDC_HTTP_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether an OIDC endpoint uses TLS or an explicit local loopback exception. */
export function isSecureOidcUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" ||
			(url.protocol === "http:" && OIDC_HTTP_LOOPBACK_HOSTS.has(url.hostname))
		);
	} catch {
		return false;
	}
}
