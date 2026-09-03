import { useEffect, useState } from "react";
import { signIn } from "./auth";
import { useGoogleAuthEnabled, useOidcProvider } from "./authProviders";
import { ThemeToggle } from "./ThemeToggle";

const RETRY = "Sign-in expired. Please try again.";

const AUTH_ERROR_MESSAGES: Record<string, string> = {
	signup_disabled:
		"No Solar account exists for this email. Ask an admin to create one.",
	account_not_linked:
		"This email is already registered with a different sign-in method.",
	account_already_linked_to_different_user:
		"That identity is already linked to another Solar account.",
	unable_to_link_account: "Could not link this identity to a Solar account.",
	unable_to_create_user: "Could not create an account for this sign-in.",
	email_not_found: "The identity provider did not return an email address.",
	email_not_verified:
		"The identity provider has not verified this email address.",
	email_does_not_match: "That identity uses a different email address.",
	unable_to_get_user_info:
		"Could not read your profile from the identity provider.",
	issuer_mismatch:
		"The identity provider's issuer does not match its configuration.",
	EMAIL_DOMAIN_NOT_ALLOWED:
		"That email domain is not allowed to sign in to this deployment.",
	ACCOUNT_DISABLED: "This account is disabled.",
	access_denied: "Sign-in was cancelled.",
	state_mismatch: RETRY,
	state_not_found: RETRY,
	state_security_mismatch: RETRY,
	nonce_binding_missing: RETRY,
	invalid_code: RETRY,
	no_code: RETRY,
};

/**
 * Turns a redirected OAuth failure into something a person can act on.
 *
 * Better Auth sends its own lowercase codes; errors thrown by Solar's database
 * hooks arrive as their message with spaces replaced by underscores, and codes
 * we raise ourselves carry a readable description.
 */
export function describeAuthError(
	code: string,
	description?: string | null,
): string {
	const known = AUTH_ERROR_MESSAGES[code];
	if (known) return known;
	if (description) return description;
	const spaced = code.replace(/_/g, " ");
	return /^[a-z]/.test(spaced) ? `Sign-in failed (${spaced})` : spaced;
}

/** Minimal email/password login, plus any configured identity providers. */
export function AuthForm() {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const googleEnabled = useGoogleAuthEnabled();
	const oidcProvider = useOidcProvider();

	// A failed provider sign-in redirects back here with the reason in the
	// query string, since the redirect means signIn() never returns an error.
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const code = params.get("error");
		if (!code) return;
		setError(describeAuthError(code, params.get("error_description")));
		params.delete("error");
		params.delete("error_description");
		const query = params.toString();
		window.history.replaceState(
			null,
			"",
			`${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
		);
	}, []);

	async function signInWithGoogle() {
		setBusy(true);
		setError(null);
		const res = await signIn.social({
			provider: "google",
			errorCallbackURL: "/",
		});
		setBusy(false);
		if (res.error) setError(res.error.message ?? "Authentication failed");
	}

	/** Starts OIDC sign-in and returns both success and failure to this page. */
	async function signInWithOidc() {
		setBusy(true);
		setError(null);
		const res = await signIn.social({
			provider: "oidc",
			callbackURL: "/",
			errorCallbackURL: "/",
		});
		setBusy(false);
		if (res.error) setError(res.error.message ?? "Authentication failed");
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		if (document.activeElement instanceof HTMLElement)
			document.activeElement.blur();
		setBusy(true);
		setError(null);
		const res = await signIn.email({ email, password });
		setBusy(false);
		if (res.error) setError(res.error.message ?? "Authentication failed");
	}

	return (
		<main className="solar-auth grid min-h-dvh place-items-center p-5">
			<section className="solar-panel card w-full max-w-sm border shadow-sm">
				<div className="card-body gap-5">
					<div className="flex items-start justify-between">
						<div>
							<p className="mb-1 text-sm tracking-[0.18em] uppercase opacity-60">
								A place to think
							</p>
							<h1 className="solar-wordmark m-0 text-5xl">Solar</h1>
						</div>
						<ThemeToggle />
					</div>
					<form onSubmit={submit} className="grid gap-3">
						<input
							className="input w-full"
							type="email"
							placeholder="Email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							required
						/>
						<input
							className="input w-full"
							type="password"
							placeholder="Password (min 8)"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							required
							minLength={8}
						/>
						<button
							className="btn btn-primary w-full"
							type="submit"
							disabled={busy}
						>
							Sign in
						</button>
					</form>
					{(googleEnabled || oidcProvider) && (
						<div className="grid gap-3">
							<div className="divider my-0">or</div>
							{googleEnabled && (
								<button
									className="btn w-full"
									type="button"
									onClick={signInWithGoogle}
									disabled={busy}
								>
									{busy && (
										<span className="loading loading-spinner loading-sm" />
									)}
									Continue with Google
								</button>
							)}
							{oidcProvider && (
								<button
									className="btn w-full"
									type="button"
									onClick={signInWithOidc}
									disabled={busy}
								>
									{busy && (
										<span className="loading loading-spinner loading-sm" />
									)}
									Continue with {oidcProvider.displayName}
								</button>
							)}
						</div>
					)}
					{error && <p className="text-error">{error}</p>}
				</div>
			</section>
		</main>
	);
}
