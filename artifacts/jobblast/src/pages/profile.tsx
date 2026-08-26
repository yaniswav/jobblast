import { Check, Eye, FileText, Plus, Save, Trash2, Upload, UserRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { getGetProfileQueryKey, getGetDocumentFileUrl, getListDocumentsQueryKey, useGetProfile, useListDocuments, useUpdateProfile, useUploadDocument, type DocumentType } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ErrorState, LoadingState } from '@/components/app-shell';
import { useLocale, useT, type TranslationKey } from '@/i18n';

type ProfileForm = { name: string; headline: string; targetRoles: string[]; targetLocations: string[]; salaryFloor: string; excludedCompanies: string[]; masterResume: string };

const blank: ProfileForm = { name: '', headline: '', targetRoles: [], targetLocations: [], salaryFloor: '', excludedCompanies: [], masterResume: '' };

export default function Profile() {
  const t = useT();
  const profile = useGetProfile();
  const update = useUpdateProfile();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ProfileForm>(blank);
  const [newRole, setNewRole] = useState('');
  const [newLocation, setNewLocation] = useState('');
  const [newExcluded, setNewExcluded] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (profile.data) setForm({ name: profile.data.name, headline: profile.data.headline, targetRoles: profile.data.targetRoles, targetLocations: profile.data.targetLocations, salaryFloor: String(profile.data.salaryFloor), excludedCompanies: profile.data.excludedCompanies, masterResume: profile.data.masterResume }); }, [profile.data]);
  if (profile.isLoading) return <LoadingState label={t('loading.profile')} />;
  if (profile.isError || !profile.data) return <div className="content-wrap"><ErrorState onRetry={() => profile.refetch()} /></div>;
  const set = (key: keyof ProfileForm, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const addItem = (key: 'targetRoles' | 'targetLocations' | 'excludedCompanies', value: string, reset: (value: string) => void) => { const item = value.trim(); if (item && !form[key].includes(item)) setForm((current) => ({ ...current, [key]: [...current[key], item] })); reset(''); };
  const removeItem = (key: 'targetRoles' | 'targetLocations' | 'excludedCompanies', item: string) => setForm((current) => ({ ...current, [key]: current[key].filter((value) => value !== item) }));
  const save = () => update.mutate({ data: { name: form.name, headline: form.headline, targetRoles: form.targetRoles, targetLocations: form.targetLocations, salaryFloor: Number(form.salaryFloor), excludedCompanies: form.excludedCompanies, masterResume: form.masterResume } }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getGetProfileQueryKey() }); setSaved(true); window.setTimeout(() => setSaved(false), 2400); } });
  return <div className="content-wrap"><section className="mb-7"><div className="eyebrow">{t('profile.eyebrow')}</div><div className="mt-3 flex flex-wrap items-end justify-between gap-4"><div><h1 className="page-title">{t('profile.title')}</h1><p className="page-subtitle">{t('profile.subtitle')}</p></div>{saved && <div className="badge badge-green" data-testid="status-profile-saved"><Check size={13} /> {t('profile.saved')}</div>}</div></section><div className="grid gap-5 lg:grid-cols-[.85fr_1.15fr]"><section className="surface p-6"><div className="flex items-center gap-3 mb-6"><div className="avatar avatar-lg"><UserRound size={20} /></div><div><h2 className="font-bold">{t('profile.identity')}</h2><p className="text-xs text-[hsl(var(--muted-foreground))]">{t('profile.identitySubtitle')}</p></div></div><div className="grid gap-4"><div><label className="label" htmlFor="profile-name">{t('profile.name')}</label><input id="profile-name" className="input" value={form.name} onChange={(event) => set('name', event.target.value)} data-testid="input-profile-name" /></div><div><label className="label" htmlFor="profile-email">{t('profile.email')}</label><input id="profile-email" className="input opacity-65" value={profile.data.email} readOnly data-testid="input-profile-email" /></div><div><label className="label" htmlFor="profile-headline">{t('profile.headline')}</label><input id="profile-headline" className="input" value={form.headline} onChange={(event) => set('headline', event.target.value)} data-testid="input-profile-headline" /></div><div><label className="label" htmlFor="profile-salary">{t('profile.salaryFloor')}</label><div className="relative"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-[hsl(var(--muted-foreground))]">$</span><input id="profile-salary" className="input pl-7" type="number" value={form.salaryFloor} onChange={(event) => set('salaryFloor', event.target.value)} data-testid="input-profile-salary" /></div></div></div></section><section className="surface p-6"><div className="flex items-center gap-3 mb-6"><div className="avatar avatar-lg bg-[hsl(var(--accent)/.22)] text-[hsl(var(--accent-foreground))]">◎</div><div><h2 className="font-bold">{t('profile.targeting')}</h2><p className="text-xs text-[hsl(var(--muted-foreground))]">{t('profile.targetingSubtitle')}</p></div></div><div className="grid gap-5"><TagEditor label={t('profile.targetRoles')} values={form.targetRoles} draft={newRole} setDraft={setNewRole} onAdd={() => addItem('targetRoles', newRole, setNewRole)} onRemove={(item) => removeItem('targetRoles', item)} placeholder={t('profile.targetRolesPlaceholder')} testId="role" /><TagEditor label={t('profile.targetLocations')} values={form.targetLocations} draft={newLocation} setDraft={setNewLocation} onAdd={() => addItem('targetLocations', newLocation, setNewLocation)} onRemove={(item) => removeItem('targetLocations', item)} placeholder={t('profile.targetLocationsPlaceholder')} testId="location" /><TagEditor label={t('profile.excludedCompanies')} values={form.excludedCompanies} draft={newExcluded} setDraft={setNewExcluded} onAdd={() => addItem('excludedCompanies', newExcluded, setNewExcluded)} onRemove={(item) => removeItem('excludedCompanies', item)} placeholder={t('profile.excludedCompaniesPlaceholder')} testId="excluded" /></div></section></div><section className="surface p-6 mt-5"><div className="section-heading"><div><h2>{t('profile.masterResume')}</h2><p>{t('profile.masterResumeSubtitle')}</p></div><span className="font-mono-app text-[10px] text-[hsl(var(--muted-foreground))]">{t('common.charsCount', { count: form.masterResume.length })}</span></div><textarea className="textarea min-h-[260px] mt-3" value={form.masterResume} onChange={(event) => set('masterResume', event.target.value)} placeholder={t('profile.masterResumePlaceholder')} data-testid="textarea-master-resume" /></section><DocumentsCard /><div className="flex justify-end mt-5"><button className="btn btn-primary" onClick={save} disabled={update.isPending} data-testid="button-save-profile"><Save size={15} /> {update.isPending ? t('profile.savingProfile') : t('profile.saveProfile')}</button></div></div>;
}

function formatBytes(bytes: number, t: ReturnType<typeof useT>): string {
  if (bytes < 1024) return `${bytes} ${t('profile.bytesUnit')}`;
  const units: TranslationKey[] = ['profile.kilobytesUnit', 'profile.megabytesUnit', 'profile.gigabytesUnit'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) { value /= 1024; unitIndex += 1; }
  return `${value.toFixed(1)} ${t(units[unitIndex])}`;
}

function DocumentsCard() {
  const t = useT();
  const [locale] = useLocale();
  const documents = useListDocuments();
  const upload = useUploadDocument();
  const queryClient = useQueryClient();
  const cvInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const inputRefs: Record<DocumentType, React.RefObject<HTMLInputElement | null>> = { cv: cvInputRef, cover_letter: coverInputRef };
  const documentLabels: Record<DocumentType, string> = { cv: t('profile.documentCv'), cover_letter: t('profile.documentCoverLetter') };
  const byType = (type: DocumentType) => documents.data?.find((doc) => doc.type === type);
  const formatDate = (iso: string): string => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  const handleFileChange = (type: DocumentType) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.type !== 'application/pdf') { toast(t('profile.toastPdfOnly')); return; }
    upload.mutate({ type, data: { file } }, {
      onSuccess: (result) => {
        queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
        if (type === 'cv') {
          queryClient.invalidateQueries({ queryKey: getGetProfileQueryKey() });
          toast(result.resumeUpdated ? t('profile.toastCvUpdatedResume') : t('profile.toastCvUpdated'));
        } else {
          toast(t('profile.toastCoverLetterUpdated'));
        }
      },
      onError: () => toast(t('profile.toastUploadFailed')),
    });
  };
  return <section className="surface p-6 mt-5"><div className="section-heading"><div><h2>{t('profile.documents')}</h2><p>{t('profile.documentsSubtitle')}</p></div></div><div className="grid gap-3 mt-3 sm:grid-cols-2">{(['cv', 'cover_letter'] as const).map((type) => { const doc = byType(type); return <div key={type} className="rounded-xl border border-[hsl(var(--border))] p-4" data-testid={`card-document-${type}`}><div className="flex items-center gap-2 mb-2"><FileText size={16} className="text-[hsl(var(--muted-foreground))]" /><span className="font-bold text-sm">{documentLabels[type]}</span></div>{doc ? <div className="text-xs text-[hsl(var(--muted-foreground))]"><div className="truncate font-medium text-[hsl(var(--foreground))]" data-testid={`text-filename-${type}`}>{doc.filename}</div><div className="mt-1">{formatBytes(doc.sizeBytes, t)} · {formatDate(doc.uploadedAt)}</div></div> : <div className="text-xs text-[hsl(var(--muted-foreground))]">{t('profile.noDocumentUploaded')}</div>}<div className="flex gap-2 mt-3">{doc && <a className="btn btn-ghost flex-1" href={getGetDocumentFileUrl(type)} target="_blank" rel="noreferrer" data-testid={`link-view-document-${type}`}><Eye size={14} /> {t('profile.viewDocument')}</a>}<button className="btn btn-ghost flex-1" onClick={() => inputRefs[type].current?.click()} disabled={upload.isPending} data-testid={`button-replace-document-${type}`}><Upload size={14} /> {t('profile.replaceDocument')}</button><input ref={inputRefs[type]} type="file" accept="application/pdf" className="hidden" onChange={handleFileChange(type)} data-testid={`input-file-${type}`} /></div></div>; })}</div></section>;
}

// Exported for reuse by the onboarding wizard's search-criteria step
// (pages/onboarding.tsx), which needs the same "add a tag, remove a tag"
// editor for keywords and target locations.
export function TagEditor({ label, values, draft, setDraft, onAdd, onRemove, placeholder, testId }: { label: string; values: string[]; draft: string; setDraft: (value: string) => void; onAdd: () => void; onRemove: (value: string) => void; placeholder: string; testId: string }) {
  const t = useT();
  return <div><label className="label">{label}</label><div className="flex gap-2"><input className="input" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); onAdd(); } }} placeholder={placeholder} data-testid={`input-profile-${testId}`} /><button className="btn btn-ghost icon-btn" onClick={onAdd} aria-label={t('profile.addAriaLabel', { label })} data-testid={`button-add-${testId}`}><Plus size={16} /></button></div><div className="flex flex-wrap gap-2 mt-3">{values.map((item) => <span className="tag pr-1" key={item}>{item}<button className="ml-1 p-1 rounded hover:bg-[hsl(var(--border))]" onClick={() => onRemove(item)} aria-label={t('profile.removeAriaLabel', { item })} data-testid={`button-remove-${testId}-${item.toLowerCase().replaceAll(' ', '-')}`}><Trash2 size={11} /></button></span>)}</div></div>;
}
