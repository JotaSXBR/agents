import { Building2, ImageUp, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Card, FormField, Input, useToast } from "@/client/components";
import { api } from "@/client/lib/api";
import { mediaFetch } from "@/client/lib/media";

// The letterhead every issued document carries: name, tax id, address, contacts and a logo. It lives
// on this tab rather than in Settings because it exists only to feed documents, and an operator
// setting up their first template should not have to go find it.

type SettingsData = Awaited<
  ReturnType<(typeof api.api.v1)["tenant-settings"]["get"]>
>["data"];
export type CompanyProfile = NonNullable<SettingsData>["company"];

const FIELDS = [
  "name",
  "document",
  "address",
  "phone",
  "email",
  "website",
] as const;

export function CompanyProfileCard({
  company,
  onChanged,
}: {
  company: CompanyProfile | null;
  onChanged: (next: CompanyProfile) => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!company) return;
    setDraft(
      Object.fromEntries(FIELDS.map((f) => [f, company[f] ?? ""])) as Record<
        string,
        string
      >,
    );
  }, [company]);

  // The logo endpoint is tenant-scoped, so a bare <img src> would omit the active-tenant header and
  // a SUPER_ADMIN would get "a target tenant is required" instead of a picture. mediaFetch + a blob
  // URL is the same fix MediaImage applies.
  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    if (!company?.logoKey) {
      setLogoUrl(null);
      return;
    }
    void (async () => {
      const res = await mediaFetch(
        `/api/v1/tenant-settings/company/logo?v=${company.logoVersion}`,
      );
      if (!res.ok || cancelled) return;
      revoked = URL.createObjectURL(await res.blob());
      setLogoUrl(revoked);
    })();
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
    // The VERSION, not the key: the key is derived from the tenant id and the file extension, so
    // replacing a PNG with another PNG leaves it identical and this effect would never run again —
    // the card would keep showing the previous letterhead while issued documents carry the new one.
    // It is also the cache buster the response's own max-age needs.
  }, [company?.logoKey, company?.logoVersion]);

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
    try {
      const { data, error } = await api.api.v1["tenant-settings"].company.put(
        draft as Record<(typeof FIELDS)[number], string>,
      );
      if (error || !data) {
        showToast(t("documents.company.saveError", "Could not save."), "error");
        return;
      }
      onChanged(data.company);
      showToast(t("common.saved", "Saved."), "success");
    } finally {
      setSaving(false);
    }
  }

  async function upload(file: File) {
    const { data, error } = await api.api.v1[
      "tenant-settings"
    ].company.logo.post({ file });
    if (error || !data) {
      showToast(
        t(
          "documents.company.logoError",
          "Could not upload. The logo must be a PNG or JPEG under 512 KB.",
        ),
        "error",
      );
      return;
    }
    onChanged(data.company);
  }

  async function removeLogo() {
    const { data } = await api.api.v1["tenant-settings"].company.logo.delete();
    if (data) onChanged(data.company);
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
              value={draft[field] ?? ""}
              onChange={(e) =>
                setDraft((d) => ({ ...d, [field]: e.target.value }))
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
