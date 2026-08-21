/**
 * navigator.clipboard is secure-context-only (gone over plain HTTP, e.g.
 * browsing Solar from another machine's IP). Fall back to the legacy
 * execCommand copy, which works everywhere.
 */
export async function copyText(text: string): Promise<void> {
	if (typeof navigator.clipboard?.writeText === "function") {
		await navigator.clipboard.writeText(text);
		return;
	}
	const textarea = document.createElement("textarea");
	textarea.value = text;
	// Keep it invisible but renderable: position it off-screen rather than
	// display:none, which some engines refuse to copy from.
	textarea.style.position = "fixed";
	textarea.style.top = "-1000px";
	document.body.appendChild(textarea);
	textarea.select();
	try {
		document.execCommand("copy");
	} finally {
		textarea.remove();
	}
}
