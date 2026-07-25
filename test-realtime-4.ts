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
  console.log("Token status:", response.status);
  const data = await response.json();
  const ephemeralKey = data.client_secret.value;

  const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ephemeralKey}`,
      "Content-Type": "application/sdp",
    },
    body: "v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=extmap-allow-mixed\r\na=msid-semantic: WMS\r\n"
  });
  console.log("SDP status:", sdpResponse.status);
  const sdpText = await sdpResponse.text();
  console.log(sdpText.substring(0, 100));
}
main();
