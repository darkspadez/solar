import { ThinkingOrb } from "thinking-orbs";
import { useDarkTheme } from "./MarkdownText";
import type { ComponentProps } from "react";

export function OrbLoader(props: Omit<ComponentProps<typeof ThinkingOrb>, "theme">) {
	const dark = useDarkTheme();
	return <ThinkingOrb theme={dark ? "dark" : "light"} {...props} />;
}
