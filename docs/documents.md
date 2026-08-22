# Documents: templates, issuance, delivery

The operator defines a **document template** — a quote, a proposal, a receipt, a service order — and
the agent **issues one from inside the conversation and attaches it to its reply**. A document is a
PDF the customer keeps, so everything here is built around the three properties that follow from
that: it must be right, it must not change after it is sent, and it must not be sent by accident.

This replaces the `quotes` subsystem, which rendered a PDF and had no way to author one, no way for
an agent to produce one, and no way to hand one to a customer.

## The pieces

| | |
| --- | --- |
| `DocumentTemplate` | blocks (the layout), fields (what the agent fills), style, numbering |
| `IssuedDocument` | one rendered document: its number, its frozen snapshot, its PDF |
| company profile | the letterhead, in `Tenant.settings.company` + a logo on disk |
| the agent's tool | one per granted template, named `send_<slug>` |

## Blocks

A document is an ordered list of blocks, from a **closed** vocabulary
(`src/modules/documents/blocks.ts`): `header`, `text`, `fields`, `lineItems`, `totals`, `divider`.
Every block carries an `id` (so the console can edit one across a reorder made from the API) and an
optional `spaceAfter`.

The set is closed because every block is something the renderer knows how to lay out. What it does
not cover goes into a `text` block as prose — that is the escape hatch, and it is why there is no
`html` or `raw` block. `text` understands a small markdown: `**bold**`, `*italic*` / `_italic_`,
`- ` bullets, and nothing else. Anything richer renders as its own source, which is deliberate:
a construct the parser half-understands produces layout nobody authored, in a document a customer
keeps.

`totals` computes its own arithmetic from the line items, in integer cents. A model is never asked
for a sum: it will eventually get one wrong in front of a customer, and the number it got wrong is a
price. A discount larger than the subtotal is clamped, and the CLAMPED value is what is printed — so
the three numbers on the page always add up to each other.

## Fields and tokens

`fields` is the contract: `{name, label, type, required?, description?}` with
`text | number | date | currency | lineItems`. It is what makes "custom fields the agent fills"
real — the declared fields become the **argument list of the tool the agent gets**, so the operator
writes the contract once and the model sees exactly it.

Any text in a block may carry `{{tokens}}`:

| namespace | tokens |
| --- | --- |
| company | `company_name`, `company_document`, `company_address`, `company_phone`, `company_email`, `company_website` |
| document | `doc_number`, `doc_date`, `doc_title` |
| fields | any declared field, by its own name |

Each reserved token has a pt-BR alias (`empresa_nome`, `documento_numero`, …) that resolves to the
same value. A field name may not start with `company_`, `empresa_`, `doc_` or `documento_`, and a
token naming neither a declared field nor a reserved name is **refused when the template is
written** — because downstream it is a blank space in a PDF the customer keeps and nothing reports
it.

This is a sibling of the system prompt's placeholder machinery, deliberately not the same code.
`PROMPT_PLACEHOLDER_SOURCE` is a shared contract (the prompt editor's highlighter, the cache warning,
the prompt audit), an unresolved prompt placeholder is left LITERAL, and `sanitizePromptValue`
collapses every run of whitespace — right for one line of a prompt, wrong for a "payment terms" field
that is legitimately several lines.

## Style

`font` (`sans`/`serif`/`mono`), `baseFontSize`, `accentColor`, `margin`, `pageSize`, `locale`,
`currency`, `footerText`, `showPageNumbers`.

The three families are `@react-pdf/renderer`'s built-ins. There is no `Font.register` and no bundled
TTF: a face resolves from a path that differs between the dev tree and the container, the registry it
goes into is global and does not deduplicate, and the built-ins cover Latin-1, which is what PT-BR
needs. A bundled family is purely additive later.

## Issuing

`issueDocument` is one core with two callers (`POST /v1/documents` and the agent's tool), two-phase
and idempotent:

1. **The idempotency key is checked first**, before the template is even read. The key means the
   document already exists and its content was frozen when it was issued — validating the caller's
   values against the template as it stands *today* would make a retry fail the moment the template
   changed.
2. Otherwise: load the template, validate the values, freeze a **snapshot** (blocks, fields, style,
   company profile and values as resolved), insert the PENDING row, take a number.
3. Render the STORED snapshot outside any transaction, write it to a path derived from numeric ids,
   CAS to READY.

The number comes from `UPDATE document_templates SET last_number = last_number + 1 … RETURNING`, so
the row lock makes it atomic. It is bumped AFTER the insert, so losing a race on the key does not
consume one. Monotonic, not gapless.

## Delivery

A document tool **issues and queues in one call**: issuing and sending are one act from the
customer's side, and splitting them would cost a model round-trip and open a window where a numbered
document exists and nobody was told.

Delivery itself happens in the runtime, after the same gates the reply passes (ownership recheck,
supersede gate, output guardrail), ahead of the reply text — the shared `TurnState.pendingAttachments`
queue that `send_image` also uses. One queue, because the gates a file has to pass to reach a
customer are a property of the TURN, not of what the file is. Each entry carries the **tool** that
queued it (for the flow line) and its **kind** (for the quota): reading one field for both questions
is how a document would land in the image budget.

At most one document per turn, checked twice around the await because one model response's tool calls
run under `Promise.all`. The first check is what stops a second numbered row being created and thrown
away.

## Granting

`AgentToolSelection` with `source = DOCUMENT` and a `documentTemplateId`. **Fail-closed**, like
HTTP/MCP/integration/RAG and unlike NATIVE: an agent with no grant has no document tool, so no
existing agent gains one on upgrade.

## Transports

- **Console** — Components → Document templates. Create from a ready-made starter (quote, proposal,
  receipt), edit the letterhead, edit the **wording** of `text` blocks, and watch a live PDF preview.
  Adding, removing and reordering blocks is API/MCP only, and the panel says so.
- **REST** — `/v1/document-templates` (CRUD, `POST /preview`, `/starters`), `/v1/documents` (issue,
  list, PDF, revoke), `/v1/tenant-settings/company` (+ `/logo`).
- **MCP** — `document_template_list/get/create/update/delete`, `document_template_schema`,
  `document_starters_list`, `issued_document_list`. `document_template_schema` serves the block
  vocabulary as JSON Schema generated from the validator; see `docs/mcp.md` for why it is not
  published in every `tools/list`.

The preview renders an **unsaved draft**, which is what makes authoring through the API bearable:
build the blocks from a script or an MCP client, then look at the document. The MCP dry-run renders
too, so a `document_template_create` that would not lay out fails before it saves.

## Storage

`DOCUMENTS_STORAGE_DIR` holds `<tenantId>/<documentId>.pdf` and `company/<tenantId>-logo.<ext>`.
`QUOTES_STORAGE_DIR` is still read as a fallback, and that is not tidiness: platforms that freeze a
compose value at install time (Coolify) never hand an existing installation the new name, and without
the fallback that installation writes inside the container and loses every PDF on the next redeploy.

The filesystem has no RLS, so the **scoped read of the row** is the boundary: a storage key is only
resolvable for the owning tenant, and every refusal is a 404 — which of the reasons applies is
information about a document the caller may not be entitled to know exists.

The logo is read from disk as **bytes** and never as a URL: `@react-pdf/renderer` will fetch an
`<Image src>` over the network, which on a server renderer is a request driven by tenant input. Its
allowlist is narrower than branding's (PNG/JPEG only) because the PDF renderer decodes fewer formats
than a browser, and an SVG would feed an XML parser inside the renderer for no benefit.
