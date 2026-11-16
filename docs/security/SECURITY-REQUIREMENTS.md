# Security gates — blocking

S1. Importers never execute source content, code, commands, scripts or hyperlinks.
S2. Default capture remains local; no automatic upload of raw sessions, prompts or tool results.
S3. Secrets/PII redaction must happen before external model calls; user confirms when sending sensitive records. Avoid asserting that simple regexes guarantee perfect redaction.
S4. Every output file path is validated and confined to selected output location; defend against symlinks, traversal and overwrite.
S5. HTML export must escape untrusted event content; sanitization tests cover `<script>`, event handlers and URLs.
S6. Ingest handles arbitrary truncated/untrusted JSONL with bounded size, depth and resources and actionable errors.
S7. Source metadata and integrity hashes remain verifiable; never silently rewrite evidence data.
S8. Security narrative must distinguish observed request, attempted action, successful execution, model hypothesis, and verified result.
S9. Hooks/plugins must never be installed or globally enabled without explicit user consent; installation scripts reviewed.
S10. No replay of network, OS or filesystem effects automatically; replay future requires explicit side-effect policy and sandbox.
S11. No autonomous target scanning, credential collection, exploitation or exfiltration is part of this product. It documents authorized research only.
S12. A failed security gate blocks the slice; reviewer cannot self-approve fixes.
