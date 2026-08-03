import { auth, createSolarApiKey, getSolarSession } from "../auth";
import { sqlite } from "../db";

export interface OpenWebUiPrincipal {
	id: string;
	name: string;
	email: string;
	role: string;
	isAdmin: boolean;
}

interface UserRow {
	id: string;
	name: string;
	email: string;
	role: string;
	isDisabled: number;
}

function principal(row: UserRow | null): OpenWebUiPrincipal | null {
	if (!row || row.isDisabled) return null;
	return {
		id: row.id,
		name: row.name,
		email: row.email,
		role: row.role,
		isAdmin: row.role === "admin",
	};
}

function findUser(userId: string): OpenWebUiPrincipal | null {
	return principal(
		sqlite
			.query("SELECT id, name, email, role, isDisabled FROM user WHERE id = ?")
			.get(userId) as UserRow | null,
	);
}

function bearerToken(headers: Headers): string | null {
	const value = headers.get("authorization");
	if (!value?.startsWith("Bearer ")) return null;
	const token = value.slice("Bearer ".length).trim();
	return token || null;
}

async function resolveApiKey(
	token: string,
): Promise<OpenWebUiPrincipal | null> {
	if (!token.startsWith("sk_solar_")) return null;
	try {
		const api = auth.api as unknown as {
			verifyApiKey(input: { body: { key: string } }): Promise<{
				valid: boolean;
				key: { referenceId: string } | null;
			}>;
		};
		const result = await api.verifyApiKey({ body: { key: token } });
		return result.valid && result.key ? findUser(result.key.referenceId) : null;
	} catch {
		return null;
	}
}

async function resolveSessionToken(
	token: string,
): Promise<OpenWebUiPrincipal | null> {
	try {
		const sessionHeaders = new Headers({
			cookie: `better-auth.session_token=${token}`,
		});
		const session = await getSolarSession(sessionHeaders);
		return session ? findUser(session.user.id) : null;
	} catch {
		return null;
	}
}

export async function resolveOpenWebUiPrincipal(
	headers: Headers,
): Promise<OpenWebUiPrincipal | null> {
	const token = bearerToken(headers);
	if (token) {
		const apiKeyPrincipal = await resolveApiKey(token);
		if (apiKeyPrincipal) return apiKeyPrincipal;
		const sessionPrincipal = await resolveSessionToken(token);
		if (sessionPrincipal) return sessionPrincipal;
	}
	const session = await getSolarSession(headers);
	return session ? findUser(session.user.id) : null;
}

export async function signInOpenWebUi(
	email: string,
	password: string,
): Promise<{ token: string; user: OpenWebUiPrincipal } | null> {
	try {
		const result = await auth.api.signInEmail({ body: { email, password } });
		const user = findUser(result.user.id);
		if (!user) return null;
		const apiKey = await createSolarApiKey("Open WebUI", user.id);
		return { token: apiKey.key, user };
	} catch {
		return null;
	}
}
