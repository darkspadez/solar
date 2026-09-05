import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

interface AuthResult {
	error: { message?: string } | null;
}

const signInEmail = mock(
	async (_credentials: {
		email: string;
		password: string;
	}): Promise<AuthResult> => ({ error: null }),
);
const signInSocial = mock(
	async (_options: {
		provider: string;
		errorCallbackURL?: string;
	}): Promise<AuthResult> => ({
		error: null,
	}),
);
const signInSocialOidc = mock(
	async (_options: {
		provider: string;
		callbackURL?: string;
		errorCallbackURL?: string;
	}): Promise<AuthResult> => ({ error: null }),
);

// Google and OIDC now share signIn.social; route by provider so each
// assertion can see only its own call.
mock.module("./auth", () => ({
	signIn: {
		email: signInEmail,
		social: (options: { provider: string }) =>
			options.provider === "oidc"
				? signInSocialOidc(options as never)
				: signInSocial(options as never),
	},
}));
mock.module("./ThemeToggle", () => ({ ThemeToggle: () => null }));

let googleEnabled = true;
let oidcProvider: { displayName: string } | null = { displayName: "Keycloak" };
mock.module("./authProviders", () => ({
	useGoogleAuthEnabled: () => googleEnabled,
	useOidcProvider: () => oidcProvider,
	useAirgapMode: () => false,
}));

const { AuthForm, describeAuthError } = await import("./AuthForm");

// Happy DOM starts at about:blank, where a relative replaceState cannot
// resolve, so point the environment at a real origin first.
function setSearch(search: string) {
	(
		window as unknown as { happyDOM?: { setURL?: (url: string) => void } }
	).happyDOM?.setURL?.(`http://localhost/${search}`);
}

beforeEach(() => {
	signInEmail.mockClear();
	signInSocial.mockClear();
	signInSocialOidc.mockClear();
	googleEnabled = true;
	oidcProvider = { displayName: "Keycloak" };
	setSearch("");
});

describe("AuthForm", () => {
	test("submits email and password when signing in", async () => {
		const user = userEvent.setup();
		render(<AuthForm />);

		await user.type(screen.getByPlaceholderText("Email"), "person@example.com");
		await user.type(
			screen.getByPlaceholderText("Password (min 8)"),
			"password",
		);
		await user.click(screen.getByRole("button", { name: "Sign in" }));

		expect(signInEmail).toHaveBeenCalledWith({
			email: "person@example.com",
			password: "password",
		});
	});

	test("does not offer self-registration", () => {
		render(<AuthForm />);

		expect(
			screen.queryByRole("button", { name: /register|create account/i }),
		).not.toBeInTheDocument();
	});

	test("starts Google sign-in", async () => {
		const user = userEvent.setup();
		render(<AuthForm />);

		await user.click(
			screen.getByRole("button", { name: "Continue with Google" }),
		);

		expect(signInSocial).toHaveBeenCalledWith({
			provider: "google",
			errorCallbackURL: "/",
		});
	});

	test("hides the Google button when Google is not configured", () => {
		googleEnabled = false;
		render(<AuthForm />);

		expect(
			screen.queryByRole("button", { name: "Continue with Google" }),
		).not.toBeInTheDocument();
	});

	test("starts OIDC sign-in with the configured provider name", async () => {
		const user = userEvent.setup();
		render(<AuthForm />);

		await user.click(
			screen.getByRole("button", { name: "Continue with Keycloak" }),
		);

		expect(signInSocialOidc).toHaveBeenCalledWith({
			provider: "oidc",
			callbackURL: "/",
			errorCallbackURL: "/",
		});
	});

	test("hides the OIDC button when no provider is configured", () => {
		oidcProvider = null;
		render(<AuthForm />);

		expect(
			screen.queryByRole("button", { name: /^Continue with/ }),
		).toHaveTextContent("Continue with Google");
	});

	test("shows a readable reason when a provider redirects back an error", () => {
		setSearch("?error=signup_disabled");
		render(<AuthForm />);

		expect(
			screen.getByText(
				"No Solar account exists for this email. Ask an admin to create one.",
			),
		).toBeInTheDocument();
	});

	test("clears the error from the address bar", () => {
		setSearch("?error=signup_disabled&keep=1");
		render(<AuthForm />);

		expect(window.location.search).toBe("?keep=1");
	});
});

describe("describeAuthError", () => {
	test("prefers a known code over the raw description", () => {
		expect(describeAuthError("access_denied", "whatever")).toBe(
			"Sign-in was cancelled.",
		);
	});

	test("prefers Solar's own copy for codes it raises itself", () => {
		expect(
			describeAuthError("ACCOUNT_DISABLED", "This account is disabled"),
		).toBe("This account is disabled.");
	});

	test("falls back to the provider's description for unmapped codes", () => {
		expect(describeAuthError("weird_code", "Something the IdP said")).toBe(
			"Something the IdP said",
		);
	});

	test("unpacks a hook message carried in the code", () => {
		expect(describeAuthError("Email_domain_is_not_allowed")).toBe(
			"Email domain is not allowed",
		);
	});

	test("falls back to naming the unknown code", () => {
		expect(describeAuthError("some_future_code")).toBe(
			"Sign-in failed (some future code)",
		);
	});
});
