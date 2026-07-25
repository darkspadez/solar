import { getSpeechConfig } from "./apps/server/src/chat/catalog.ts";

async function main() {
  const { apiKey } = await getSpeechConfig();
  if (!apiKey) throw new Error("No key");

  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: "gpt-realtime-2.1-mini",
        audio: {
          input: {
            transcription: { model: "whisper-1" }
          },
          output: {
            voice: "alloy",
          },
        },
      }
    })
  });
  console.log(response.status);
  const text = await response.text();
  console.log(text.substring(0, 200));
}
main();
