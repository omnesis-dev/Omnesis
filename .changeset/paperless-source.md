---
"omnesis": patch
---

Experimental Paperless-ngx source, offered when the gateway and collector run with `OMNESIS_EXPERIMENTAL=1`. Adding it asks for the address of a self-hosted Paperless-ngx instance (2.16 or later) and an API token from My Profile; the token's user decides what is indexed, and Omnesis only reads.

Each archived document becomes a searchable document with the OCR text Paperless-ngx already extracted, its notes, correspondent, document type, tags and custom fields, linking back to the document in the Paperless-ngx web UI. Two SQL tables come with it: `paperless_documents`, one row per document dated by the document's own date, and `paperless_custom_field_values`, whose typed columns let monetary amounts be summed and due dates compared.

Syncs fetch only what changed. A rename of a tag, correspondent, document type or custom field re-reads every document once, since Paperless-ngx does not mark the documents changed, and a daily listing of every document id is how deletions are noticed.
