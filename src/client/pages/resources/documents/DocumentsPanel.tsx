import { FileText, Link2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type AgentRef,
  AgentReferences,
  Badge,
  Button,
  Card,
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
  const [creating, setCreating] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [refs, setRefs] = useState<AgentRef[] | null>(null);
  const [deleteRefs, setDeleteRefs] = useState<AgentRef[] | null>(null);

  const editModal = useModalController<{ template: DocumentTemplate }>();
  const starterModal = useModalController();
  const refsModal = useModalController<{ name: string }>();
  const deleteModal = useModalController<{ id: string; name: string }>();

  const load = useCallback(async () => {
    setLoading(true);
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
      if (list.error || !list.data) {
        setError(true);
        return;
      }
      setTemplates([...list.data.templates]);
      setStarters(startersRes.data ? [...startersRes.data.starters] : []);
      setCompany(settings.data?.company ?? null);
      setIssued(issuedRes.data ? [...issuedRes.data.documents] : []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
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
    } finally {
      setCreating(null);
    }
  }

  async function loadRefs(id: string): Promise<AgentRef[] | null> {
    const { data } = await api.api.v1["document-templates"]({
      id,
    }).references.get();
    return data ? [...data.references.agents] : null;
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
    const res = await mediaFetch(`/api/v1/documents/${doc.id}/pdf`);
    if (!res.ok) {
      tab?.close();
      showToast(
        t("documents.openPdfError", "Could not open the PDF."),
        "error",
      );
      return;
    }
    const url = URL.createObjectURL(await res.blob());
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

  async function revoke(doc: IssuedDocument) {
    const { error: err } = await api.api.v1
      .documents({ id: doc.id })
      .revoke.post();
    if (err) {
      showToast(t("documents.revokeError", "Could not revoke."), "error");
      return;
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

      <CompanyProfileCard company={company} onChanged={setCompany} />

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
                  <p className="text-text-muted text-xs">
                    {new Date(doc.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => openPdf(doc)}
                    disabled={doc.revoked}
                  >
                    {t("documents.openPdf", "Open PDF")}
                  </Button>
                  {!doc.revoked && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => revoke(doc)}
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

      <DocumentTemplateModal modal={editModal} onSaved={() => load()} />

      <Modal
        modal={starterModal}
        title={t("documents.starterTitle", "Start from a template")}
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-muted">
            {t(
              "documents.starterHint",
              "Pick one to copy into your account, then edit its wording. Building a template block by block is done through the API or MCP.",
            )}
          </p>
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
        <AgentReferences agents={refs} />
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
          {deleteRefs && deleteRefs.length > 0 && (
            <p className="text-sm text-warning">
              {t(
                "resources.deleteRefsWarning",
                "{{count}} agent uses this and will stop working if you delete it.",
                { count: deleteRefs.length },
              )}
            </p>
          )}
          <AgentReferences agents={deleteRefs} />
        </div>
      </Modal>
    </div>
  );
}
