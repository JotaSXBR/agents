import { Building2, ImageUp, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Card, FormField, Input, useToast } from "@/client/components";
import { useNavGuard } from "@/client/contexts/NavGuardContext";
import { api } from "@/client/lib/api";
import {
  afterCompanySave,
  companyChanges,
  emptyCompanyForm,
  COMPANY_FIELDS as FIELDS,
  nextCompanyDraft,
} from "./companyDraft";
import { useCompanyLogoUrl } from "./useCompanyLogoUrl";

// The letterhead every issued document carries: name, tax id, address, contacts and a logo. It lives
// on this tab rather than in Settings because it exists only to feed documents, and an operator
// setting up their first template should not have to go find it.

type SettingsData = Awaited<
  ReturnType<(typeof api.api.v1)["tenant-settings"]["get"]>
>["data"];
export type CompanyProfile = NonNullable<SettingsData>["company"];

export function CompanyProfileCard({
  company,
  onChanged,
}: {
  company: CompanyProfile | null;
  onChanged: (next: CompanyProfile) => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  // Carries the copy it was seeded from, which is what separates "typed in" from "changed
  // elsewhere". See nextCompanyDraft.
  const [form, setForm] = useState(emptyCompanyForm);
  const draft = form.draft;
  // The letterhead is the one form on this tab that is not a modal, so nothing else stands between
  // an unsaved edit and a click on another tab — or a tenant switch, which is a full reload. The
  // same `companyChanges` the save sends is what "unsaved" means here, so the two cannot disagree.
  useNavGuard(Object.keys(companyChanges(form)).length > 0);
  const [saving, setSaving] = useState(false);
  const logoUrl = useCompanyLogoUrl(company?.logoKey, company?.logoVersion);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!company) return;
    // Every arrival goes through the same rule, including the ones this card caused: a logo write
    // answers with the whole company block, and a save echoes what we sent. Neither needs to be
    // marked as ours, because against the baseline they are already "nothing was typed" and land as
    // no-ops. (An earlier version DID mark them, and that mark is what hid the missing baseline
    // advance below.) The rule lives next door with its decision table.
    setForm((current) => nextCompanyDraft(current, company));
  }, [company]);

  const label: Record<(typeof FIELDS)[number], string> = {
    name: t("documents.company.name", "Company name"),
    document: t("documents.company.document", "Tax id"),
    address: t("documents.company.address", "Address"),
    phone: t("documents.company.phone", "Phone"),
    email: t("documents.company.email", "Email"),
    website: t("documents.company.website", "Website"),
  };

  async function save() {
    setSaving(true);
    // Only what this form changed, captured before the await: the operator can type during it, and
    // a field they never touched is not this request's to write.
    const sent = companyChanges(form);
    try {
      const { data, error } =
        await api.api.v1["tenant-settings"].company.put(sent);
      if (error || !data) {
        showToast(t("documents.company.saveError", "Could not save."), "error");
        return;
      }
      // The text is now stored, so it becomes the baseline — see afterCompanySave. Anything typed
      // while the request was in flight stays, and stays unsaved.
      setForm((current) => afterCompanySave(current, sent));
      onChanged(data.company);
      showToast(t("common.saved", "Saved."), "success");
    } catch {
      // Eden RESOLVES an HTTP error as `{ error }` and REJECTS on a transport failure — offline, a
      // reset connection. Only the first half was handled, so the second left the operator with a
      // button that did nothing and an unhandled rejection in the console.
      showToast(t("documents.company.saveError", "Could not save."), "error");
    } finally {
      setSaving(false);
    }
  }

  // The logo routes answer with the WHOLE company block. Handing it to `onChanged` replaces the
  // `company` prop, and the draft rule decides what happens to the text on its own: unsaved text
  // survives, an untouched form takes the block as it came. Nothing here has to say "this one was
  // mine".
  function applyLogoOnly(next: CompanyProfile) {
    onChanged(next);
  }

  async function upload(file: File) {
    const failed = () =>
      showToast(
        t(
          "documents.company.logoError",
          "Could not upload. The logo must be a PNG or JPEG under 512 KB.",
        ),
        "error",
      );
    try {
      const { data, error } = await api.api.v1[
        "tenant-settings"
      ].company.logo.post({ file });
      if (error || !data) return failed();
      applyLogoOnly(data.company);
    } catch {
      failed();
    }
  }

  // Both halves of a failure: Eden RESOLVES an HTTP error as `{ error }`, and the fetch can reject
  // outright. Neither said anything before — the logo simply stayed where it was, which reads as a
  // button that does not work.
  async function removeLogo() {
    try {
      const { data, error } =
        await api.api.v1["tenant-settings"].company.logo.delete();
      if (error || !data) {
        showToast(
          t("documents.company.logoRemoveError", "Could not remove the logo."),
          "error",
        );
        return;
      }
      applyLogoOnly(data.company);
    } catch {
      showToast(
        t("documents.company.logoRemoveError", "Could not remove the logo."),
        "error",
      );
    }
  }

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Building2 className="h-4 w-4 text-accent" aria-hidden="true" />
        <h2 className="font-medium text-sm text-text-primary">
          {t("documents.company.title", "Company profile")}
        </h2>
        <span className="text-text-muted text-xs">
          {t(
            "documents.company.subtitle",
            "Printed on every document you issue.",
          )}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map((field) => (
          <FormField key={field} label={label[field]}>
            <Input
              value={draft[field]}
              onChange={(e) =>
                setForm((current) => ({
                  ...current,
                  draft: { ...current.draft, [field]: e.target.value },
                }))
              }
            />
          </FormField>
        ))}
      </div>

      <FormField label={t("documents.company.logo", "Logo")} group>
        <div className="flex items-center gap-3">
          {logoUrl ? (
            <img
              src={logoUrl}
              alt={t("documents.company.logo", "Logo")}
              className="h-10 max-w-32 object-contain"
            />
          ) : (
            <span className="text-sm text-text-muted">
              {t("documents.company.noLogo", "No logo")}
            </span>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
              e.target.value = "";
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => fileRef.current?.click()}
          >
            <ImageUp className="h-4 w-4" aria-hidden="true" />
            {t("documents.company.uploadLogo", "Upload")}
          </Button>
          {company?.logoKey && (
            <Button
              variant="secondary"
              size="sm"
              onClick={removeLogo}
              aria-label={t("common.delete", "Delete")}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
        </div>
      </FormField>

      <div className="flex justify-end">
        <Button size="sm" onClick={save} loading={saving}>
          {t("common.save", "Save")}
        </Button>
      </div>
    </Card>
  );
}
