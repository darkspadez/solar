# Chat V2 Frozen Contract

Migration work targets pi-ai and pi-agent-core `0.80.10` exactly. The message
validation contract is `validation.ts`: `parseCanonicalMessage`,
`validateMessageSequence`, `validateToolPairing`, and `zeroUsage`.

The frozen schema contract is migrations `020_chat_v2.ts`,
`021_chat_v2_organization.ts`, and `022_chat_v2_voice.ts`. No later Chat V2
migrations exist at this freeze point. Canonical payloads are the validated
pi-ai message JSON in `v2_conversation_message.messageJson`; attachments remain
in `v2_attachment` and `v2_message_attachment`.

Any migration change requiring a schema or validation change must explicitly
unfreeze this contract, add a new migration, and update this note.
