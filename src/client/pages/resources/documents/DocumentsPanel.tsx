import { FileText, Link2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type AgentRef,
  AgentReferences,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  type ConfirmPayload,
  DataBoundary,
  EmptyState,
  Modal,
  useModalController,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { mediaFetch } from "@/client/lib/media";
import { type CompanyProfile, CompanyProfileCard } from "./CompanyProfileCard";
import {
  type DocumentTemplate,
  DocumentTemplateModal,
} from "./DocumentTemplateModal";

type StartersData = Awaited<
  ReturnType<(typeof api.api.v1)["document-templates"]["starters"]["get"]>
>["data"];
type Starter = NonNullable<StartersData>["starters"][number];

type IssuedData = Awaited<
  ReturnType<(typeof api.api.v1)["documents"]["get"]>
>["data"];
type IssuedDocument = NonNullable<IssuedData>["documents"][number];

export function DocumentsPanel() {
  const { t, i18n } = useTranslation();
  // The route defaults an absent locale to pt-BR, so an English console would create Portuguese
  // starters — names, wording and currency — without ever offering a choice. Normalised because the
  // route takes the two the starter table has, and the browser can hand us "en", "en-GB", "pt".
  const starterLocale = i18n.language.startsWith("pt") ? "pt-BR" : "en-US";
  const { showToast } = useToast();
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [starters, setStarters] = useState<Starter[]>([]);
  const [issued, setIssued] = useState<IssuedDocument[]>([]);
  const [company, setCompany] = useState<CompanyProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // The two secondary lists get their own flags rather than taking the whole page down: an operator
  // can still edit templates when the starter list or the recent-documents list failed — they just
  // must not be told those are empty.
  const [startersError, setStartersError] = useState(false);
  const [issuedError, setIssuedError] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // null = still loading, "error" = the lookup failed. Two states, because collapsing them leaves a
  // dialog claiming to be checking something it has already given up on.
  const [refs, setRefs] = useState<AgentRef[] | "error" | null>(null);
  const [deleteRefs, setDeleteRefs] = useState<AgentRef[] | "error" | null>(
    null,
  );

  const editModal = useModalController<{ template: DocumentTemplate }>();
  const starterModal = useModalController();
  const refsModal = useModalController<{ name: string }>();
  const deleteModal = useModalController<{ id: string; name: string }>();
  const confirm = useModalController<ConfirmPayload>();

  // `loading` is the FIRST load only. Every handler here reloads on success, and the company card
  // sits inside a boundary keyed on this flag — so a shared flag made deleting a template unmount
  // the profile editor and discard whatever the operator had typed into it, over an action that had
  // nothing to do with it. A refresh replaces the data underneath; it does not take the screen away.
  const loadedOnce = useRef(false);
  // Which load is the CURRENT one. `load` is re-created when the operator switches language, and the
  // starters are the one thing here whose content is locale-specific — so two loads can be in flight
  // with different answers to the same question, and the one that resolves LAST wins the screen. An
  // older list landing after a newer one leaves the operator creating a template in the language
  // they just switched away from, permanently and with no sign anything went wrong.
  const loadSeq = useRef(0);
  // How many times the company block has been WRITTEN from this screen. A load reads four endpoints
  // at once and applies them together, so its settings response can be a snapshot taken before a
  // save or a logo upload that has since answered — and applying it then puts the operator's own
  // change back to what it replaced, on screen, with nothing saying so. The load generation does not
  // cover this: no newer load started, a different request answered.
  const companyWrites = useRef(0);
  const applyCompany = useCallback((next: CompanyProfile) => {
    companyWrites.current++;
    setCompany(next);
  }, []);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const writes = companyWrites.current;
    const current = () => seq === loadSeq.current;
    if (!loadedOnce.current) setLoading(true);
    setError(false);
    try {
      const [list, startersRes, settings, issuedRes] = await Promise.all([
        api.api.v1["document-templates"].get(),
        api.api.v1["document-templates"].starters.get({
          query: { locale: starterLocale },
        }),
        api.api.v1["tenant-settings"].get(),
        api.api.v1.documents.get({ query: { limit: "20" } }),
      ]);
      // Every request's error, not just the list's. Eden RESOLVES an HTTP failure as `{ error }`
      // rather than rejecting, so an unchecked call reads as empty data: a settings failure rendered
      // a blank editable profile over settings that may well have values, and a starters or
      // documents failure showed "none" for a list that failed to load.
      // Superseded: a newer load started while this one was in flight, so every setter below would
      // be writing an answer to a question nobody is asking any more.
      if (!current()) return;
      if (list.error || !list.data || settings.error) {
        setError(true);
        return;
      }
      setTemplates([...list.data.templates]);
      setStarters(startersRes.data ? [...startersRes.data.starters] : []);
      setStartersError(!!startersRes.error);
      // …unless this screen wrote the block while the load was out, in which case what it holds is
      // newer than what just arrived.
      if (companyWrites.current === writes) {
        setCompany(settings.data?.company ?? null);
      }
      setIssued(issuedRes.data ? [...issuedRes.data.documents] : []);
      setIssuedError(!!issuedRes.error);
    } catch {
      if (current()) setError(true);
    } finally {
      if (current()) {
        loadedOnce.current = true;
        setLoading(false);
      }
    }
    // Reloads when the operator switches language: the starters are the one thing on this panel
    // whose CONTENT is locale-specific.
  }, [starterLocale]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createFromStarter(starter: Starter) {
    setCreating(starter.key);
    try {
      const { error: err } = await api.api.v1["document-templates"].post({
        name: starter.name,
        description: starter.description,
        blocks: starter.blocks as Record<string, unknown>[],
        fields: starter.fields as Record<string, unknown>[],
        style: starter.style as unknown as Record<string, unknown>,
        numberPrefix: starter.numberPrefix,
      });
      if (err) {
        showToast(
          t("documents.createError", "Could not create this template."),
          "error",
        );
        return;
      }
      starterModal.close();
      showToast(t("documents.created", "Template created."), "success");
      void load();
    } catch {
      // Eden REJECTS on a transport failure instead of answering `{ error }`, and only the second
      // was handled: offline, the button spun and then said nothing at all.
      showToast(
        t("documents.createError", "Could not create this template."),
        "error",
      );
    } finally {
      setCreating(null);
    }
  }

  // `null` is the LOADING state for both dialogs, so a failure must not answer with it: the delete
  // dialog would sit on "Checking…" with Confirm disabled forever, explaining nothing and offering
  // no way out. An empty list is a real answer ("nothing uses it"); a failure is its own.
  async function loadRefs(id: string): Promise<AgentRef[] | "error"> {
    try {
      const { data, error: err } = await api.api.v1["document-templates"]({
        id,
      }).references.get();
      if (err || !data) return "error";
      return [...data.references.agents];
    } catch {
      return "error";
    }
  }

  // A session token per modal open. The lookup is slow enough for an operator to close one template
  // and open another before it returns, and an unconditional assignment then shows template A's
  // agents under template B's name — in the DELETE dialog that is a wrong warning about what the
  // deletion breaks, which is the one place the operator is relying on it (docs/modals.md).
  const refsSession = useRef(0);
  const deleteSession = useRef(0);

  async function openRefs(tpl: DocumentTemplate) {
    const session = ++refsSession.current;
    setRefs(null);
    refsModal.open({ name: tpl.name });
    const loaded = await loadRefs(tpl.id);
    if (session === refsSession.current) setRefs(loaded);
  }

  async function askDelete(tpl: DocumentTemplate) {
    const session = ++deleteSession.current;
    setDeleteRefs(null);
    deleteModal.open({ id: tpl.id, name: tpl.name });
    const loaded = await loadRefs(tpl.id);
    if (session === deleteSession.current) setDeleteRefs(loaded);
  }

  async function confirmDelete() {
    const id = deleteModal.payload?.id;
    if (!id) return;
    setDeleting(true);
    try {
      const { error: err } = await api.api.v1["document-templates"]({
        id,
      }).delete();
      if (err) {
        showToast(t("documents.deleteError", "Could not delete."), "error");
        return;
      }
      showToast(t("documents.deleted", "Deleted."), "success");
      deleteModal.close();
      void load();
    } catch {
      showToast(t("documents.deleteError", "Could not delete."), "error");
    } finally {
      setDeleting(false);
    }
  }

  // A blob URL rather than a link to the endpoint. The PDF route is tenant-scoped, and for a
  // SUPER_ADMIN the tenant lives ONLY in the X-Tenant-Id header — which a plain navigation cannot
  // send, so the tab would land on "a target tenant is required" instead of the document. Same fix
  // the logo and the preview already use.
  //
  // The tab is opened SYNCHRONOUSLY, inside the click, and pointed at the blob afterwards. Opening
  // it after the await spends the browser's transient user activation on a fetch, and the popup
  // blocker then swallows the call: the button downloads the bytes and appears to do nothing.
  async function openPdf(doc: IssuedDocument) {
    // No `noopener` FEATURE here: by spec it makes window.open return null, which would leave a real
    // blank tab open with no handle to point at the blob — and the fallback would then navigate the
    // console itself away while that tab sat there empty. The handle is kept and `opener` is severed
    // on it instead, which is the same protection without losing the tab.
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    // The fetch can REJECT — offline, DNS, a dropped connection — and not merely answer non-OK. That
    // path skipped the branch below entirely, leaving the tab we just opened blank forever and the
    // operator with no message at all: a button that visibly does nothing.
    let url: string;
    try {
      const res = await mediaFetch(`/api/v1/documents/${doc.id}/pdf`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      url = URL.createObjectURL(await res.blob());
    } catch {
      tab?.close();
      showToast(
        t("documents.openPdfError", "Could not open the PDF."),
        "error",
      );
      return;
    }
    if (tab) {
      tab.location.href = url;
    } else {
      // The popup blocker refused even the synchronous open. Navigating this tab is better than a
      // button that silently does nothing.
      window.location.href = url;
    }
    // The tab has the bytes by the time it paints; holding the handle any longer leaks it for as
    // long as the console stays open.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  // Asked first, because there is no un-revoke. The PDF stops being served, and the agent's
  // idempotency key is derived from the VALUES, so every later send of the same document resolves
  // to this revoked row rather than issuing a fresh one — an accidental click on a row in a list is
  // permanent, and it takes the customer's copy with it.
  function askRevoke(doc: IssuedDocument) {
    confirm.open({
      title: t("documents.revokeTitle", "Revoke document"),
      message: t(
        "documents.revokeMessage",
        'Revoke "{{name}}"? Its PDF stops being served and this cannot be undone.',
        { name: doc.number ?? doc.title },
      ),
      danger: true,
      confirmLabel: t("documents.revoke", "Revoke"),
      onConfirm: () => revoke(doc),
    });
  }

  async function revoke(doc: IssuedDocument) {
    try {
      const { error: err } = await api.api.v1
        .documents({ id: doc.id })
        .revoke.post();
      if (err) throw err;
    } catch (e) {
      showToast(t("documents.revokeError", "Could not revoke."), "error");
      // Rethrown so the confirm dialog stays OPEN on failure, per its own contract: a revoke worth
      // asking about is worth retrying without hunting the row down in the list again. Eden
      // RESOLVES an HTTP error as `{ error }` and REJECTS on a transport failure, so both halves
      // land here.
      throw e;
    }
    showToast(t("documents.revoked", "Revoked."), "success");
    void load();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-muted">
          {t(
            "documents.subtitle",
            "Quotes, proposals and receipts your agents can issue and attach to a reply.",
          )}
        </p>
        <Button size="sm" onClick={() => starterModal.open()}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("documents.add", "New template")}
        </Button>
      </div>

      {/* Inside a boundary of its own, not beside one: rendered eagerly it showed an editable BLANK
          form while the settings request was still out, and the response then reset the draft —
          throwing away whatever the operator had already typed. And if only that request failed, the
          card stayed blank with no error, over a profile that may well have values stored. */}
      <DataBoundary loading={loading} error={error} onRetry={load}>
        <CompanyProfileCard company={company} onChanged={applyCompany} />
      </DataBoundary>

      <DataBoundary
        loading={loading}
        error={error}
        isEmpty={templates.length === 0}
        onRetry={load}
        empty={
          <EmptyState
            icon={FileText}
            title={t("documents.emptyTitle", "No document templates yet")}
            description={t(
              "documents.emptyDesc",
              "Start from a ready-made quote, proposal or receipt, then edit the wording.",
            )}
            action={
              <Button size="sm" onClick={() => starterModal.open()}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t("documents.add", "New template")}
              </Button>
            }
          />
        }
      >
        <div className="flex flex-col gap-3">
          {templates.map((tpl) => (
            <Card
              key={tpl.id}
              className="flex items-center justify-between gap-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-text-primary">
                    {tpl.name}
                  </span>
                  <Badge variant="secondary">{tpl.toolName}</Badge>
                  {!tpl.enabled && (
                    <Badge variant="secondary">
                      {t("common.disabled", "Disabled")}
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 truncate text-text-muted text-xs">
                  {tpl.description ??
                    t("documents.blockCount", "{{count}} blocks", {
                      count: tpl.blocks.length,
                    })}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => openRefs(tpl)}
                >
                  <Link2 className="h-4 w-4" aria-hidden="true" />
                  {t("resources.usage", "Usage")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => editModal.open({ template: tpl })}
                >
                  {t("common.edit", "Edit")}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => askDelete(tpl)}
                  aria-label={t("common.delete", "Delete")}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </DataBoundary>

      {issuedError && (
        <p className="text-sm text-warning">
          {t(
            "documents.issuedError",
            "Could not load the recently issued documents.",
          )}
        </p>
      )}
      {issued.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="font-medium text-sm text-text-primary">
            {t("documents.issuedTitle", "Recently issued")}
          </h2>
          <div className="flex flex-col gap-2">
            {issued.map((doc) => (
              <Card
                key={doc.id}
                className="flex items-center justify-between gap-4 py-2"
              >
                <div className="min-w-0">
                  <span className="truncate font-medium text-sm text-text-primary">
                    {doc.number ? `${doc.title} ${doc.number}` : doc.title}
                  </span>
                  {doc.revoked && (
                    <Badge variant="secondary">
                      {t("documents.revokedBadge", "Revoked")}
                    </Badge>
                  )}
                  {!doc.revoked && doc.status !== "READY" && (
                    <Badge variant="secondary">
                      {t("documents.pendingBadge", "Not rendered")}
                    </Badge>
                  )}
                  <p className="text-text-muted text-xs">
                    {new Date(doc.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => openPdf(doc)}
                    // A row exists before its PDF does: the render happens after the insert, and a
                    // failure there leaves a PENDING row with no storage key. Enabled, the button
                    // could only ever fetch a 404 and say nothing about why.
                    disabled={doc.revoked || doc.status !== "READY"}
                  >
                    {t("documents.openPdf", "Open PDF")}
                  </Button>
                  {!doc.revoked && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => askRevoke(doc)}
                    >
                      {t("documents.revoke", "Revoke")}
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog modal={confirm} />

      <DocumentTemplateModal modal={editModal} onSaved={() => load()} />

      <Modal
        modal={starterModal}
        title={t("documents.starterTitle", "Start from a template")}
        // Dismissing mid-create would leave a request in flight whose result the operator can no
        // longer see, and the template it creates would then appear in the list with no
        // explanation. It is also what keeps this dialog from being REOPENED while a request from
        // the previous opening is still out — the case that would otherwise need a session token,
        // and does not, because it cannot happen.
        onCloseRequest={creating ? () => undefined : undefined}
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-muted">
            {t(
              "documents.starterHint",
              "Pick one to copy into your account, then edit its wording. Building a template block by block is done through the API or MCP.",
            )}
          </p>
          {startersError && (
            <p className="text-sm text-warning">
              {t(
                "documents.startersError",
                "Could not load the ready-made templates.",
              )}
            </p>
          )}
          {starters.map((s) => (
            <Card
              key={s.key}
              className="flex items-center justify-between gap-4"
            >
              <div className="min-w-0">
                <p className="font-medium text-sm text-text-primary">
                  {s.name}
                </p>
                <p className="text-text-muted text-xs">{s.description}</p>
              </div>
              <Button
                size="sm"
                loading={creating === s.key}
                // Every row, not just this one: two starters picked in quick succession are two
                // templates, and the second request also clears the first one's spinner.
                disabled={creating !== null}
                onClick={() => createFromStarter(s)}
              >
                {t("documents.use", "Use")}
              </Button>
            </Card>
          ))}
        </div>
      </Modal>

      <Modal
        modal={refsModal}
        title={t("resources.usageTitle", "Where this is used")}
      >
        {refs === "error" ? (
          <p className="text-sm text-warning">
            {t(
              "documents.refsError",
              "Could not check which agents use this template.",
            )}
          </p>
        ) : (
          <AgentReferences agents={refs} />
        )}
      </Modal>

      <Modal
        modal={deleteModal}
        size="sm"
        title={t("documents.deleteTitle", "Delete document template")}
        onCloseRequest={deleting ? () => undefined : undefined}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => deleteModal.close()}
              disabled={deleting}
            >
              {t("common.cancel", "Cancel")}
            </Button>
            {/* Disabled while the reference lookup is in flight. The dialog's whole job is to say
                what this deletion breaks — which agents lose the tool — and an operator who
                confirms before that arrives deletes it without ever seeing the warning the dialog
                promises (docs/modals.md). */}
            <Button
              variant="danger"
              onClick={confirmDelete}
              loading={deleting}
              // Enabled once the lookup has ANSWERED, whether with a list or with a failure: a
              // failed check must not become a dialog the operator can never leave through the
              // button it offers. The warning below says the impact is unknown.
              disabled={deleteRefs === null}
            >
              {t("common.delete", "Delete")}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-secondary">
            {t("documents.deleteMessage", 'Delete "{{name}}"?', {
              name: deleteModal.payload?.name ?? "",
            })}
          </p>
          <p className="text-sm text-text-muted">
            {t(
              "documents.deleteNote",
              "Documents already issued from it keep their own copy and stay readable.",
            )}
          </p>
          {deleteRefs === null && (
            <p className="text-sm text-text-muted">
              {t("documents.deleteChecking", "Checking which agents use it…")}
            </p>
          )}
          {deleteRefs === "error" && (
            <p className="text-sm text-warning">
              {t(
                "documents.refsError",
                "Could not check which agents use this template.",
              )}
            </p>
          )}
          {Array.isArray(deleteRefs) && deleteRefs.length > 0 && (
            <p className="text-sm text-warning">
              {t(
                "resources.deleteRefsWarning",
                "{{count}} agent uses this and will stop working if you delete it.",
                { count: deleteRefs.length },
              )}
            </p>
          )}
          <AgentReferences
            agents={Array.isArray(deleteRefs) ? deleteRefs : null}
          />
        </div>
      </Modal>
    </div>
  );
}
