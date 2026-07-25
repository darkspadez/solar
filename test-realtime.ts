import { loadProviderConfigs } from "./apps/server/src/chat/catalog.ts";
import { db } from "./apps/server/src/db/index.ts";

async function main() {
  const configs = await loadProviderConfigs();
  const openai = configs.find(c => c.provider === "openai");
  const key = openai?.apiKey;
  if (!key) throw new Error("No key");

  for (const endpoint of ["sessions", "client_secrets"]) {
    console.log("trying", endpoint);
    const res = await fetch(`https://api.openai.com/v1/realtime/${endpoint}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-realtime-2.1-mini",
      })
    });
    console.log(endpoint, res.status);
    const text = await res.text();
    console.log(text.substring(0, 200));
  }
}
main();
