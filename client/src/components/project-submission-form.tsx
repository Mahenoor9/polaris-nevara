import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { safeErrorMsg } from '@/lib/safe-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Upload, Loader2, AlertCircle, Leaf, Clock3, Building, FileText,
  CheckCircle, ArrowRight, ArrowLeft, MapPin, LayoutGrid, BarChart2,
  BadgeCheck, CalendarClock, RefreshCw,
} from 'lucide-react';
import { useState, lazy, Suspense } from 'react';
import { generateSatellitePreview } from '@/lib/map-preview';
import { useMutation } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import { useLocation } from 'wouter';
import { z } from 'zod';

const GISLandMap = lazy(() => import('@/components/gis-land-map'));

interface ProjectSubmissionFormProps {
  onSuccess: (payload?: any) => void;
}

interface LatLng { lat: number; lng: number }

// ── Ecosystem options ─────────────────────────────────────────────────────────
const ECOSYSTEM_OPTIONS = [
  { value: 'Mangrove Forest', label: 'Mangrove Forest' },
  { value: 'Seagrass Meadow', label: 'Seagrass Meadow' },
  { value: 'Salt Marsh', label: 'Salt Marsh' },
  { value: 'Coastal Wetland', label: 'Coastal Wetland' },
  { value: 'Freshwater Wetland', label: 'Freshwater Wetland' },
  { value: 'Lake Restoration', label: 'Lake Restoration' },
  { value: 'River Restoration', label: 'River Restoration' },
  { value: 'Forest Restoration', label: 'Forest Restoration' },
  { value: 'Agricultural Regeneration', label: 'Agricultural Regeneration' },
  { value: 'Mixed Ecosystem', label: 'Mixed Ecosystem' },
  { value: 'Other / Unknown', label: 'Other / Unknown' },
];

const MONITORING_OPTIONS = [
  { value: 'biweekly', label: 'Biweekly', desc: 'Every 2 weeks' },
  { value: 'monthly', label: 'Monthly', desc: 'Once per month' },
  { value: 'quarterly', label: 'Quarterly', desc: 'Every 3 months' },
];

// ── Schema ────────────────────────────────────────────────────────────────────
const contributorSubmissionSchema = z.object({
  name: z.string().min(3, 'Project name must be at least 3 characters'),
  description: z.string().min(10, 'Please provide a description of at least 10 characters'),
  restorationObjective: z.string().min(5, 'Restoration objective is required'),
  organizationName: z.string().optional(),
  restorationNotes: z.string().optional(),
  monitoringFrequency: z.enum(['biweekly', 'monthly', 'quarterly']).default('monthly'),
  ecosystemType: z.string().min(1, 'Please select an ecosystem type'),
  landBoundary: z.array(z.object({ lat: z.number(), lng: z.number() })).min(3, 'A valid polygon boundary is required'),
});

type FormValues = z.infer<typeof contributorSubmissionSchema>;

// ── Helpers ───────────────────────────────────────────────────────────────────
function getCentroid(coords: LatLng[]): LatLng {
  if (!coords.length) return { lat: 0, lng: 0 };
  return {
    lat: coords.reduce((s, c) => s + c.lat, 0) / coords.length,
    lng: coords.reduce((s, c) => s + c.lng, 0) / coords.length,
  };
}

function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function calculatePerimeterKm(coords: LatLng[]): number {
  if (coords.length < 2) return 0;
  return Math.round(coords.reduce((t, _, i) => t + haversineKm(coords[i], coords[(i + 1) % coords.length]), 0) * 100) / 100;
}

// ── Satellite preview loading skeleton ───────────────────────────────────────
function SatellitePreviewSkeleton() {
  return (
    <div className="rounded-xl overflow-hidden border border-border/40 bg-[#1a2035] animate-pulse" style={{ height: 220 }}>
      <div className="h-full w-full flex flex-col items-center justify-center gap-2">
        <div className="w-10 h-10 rounded-full bg-teal-500/20 flex items-center justify-center">
          <Loader2 className="w-5 h-5 text-teal-400 animate-spin" />
        </div>
        <p className="text-xs text-teal-400/70 font-medium">Loading satellite imagery…</p>
      </div>
    </div>
  );
}

// ── Step wizard indicator ─────────────────────────────────────────────────────
function StepIndicator({ step }: { step: 'edit' | 'review' | 'success' }) {
  const steps = [
    { id: 'edit', label: 'Project Details' },
    { id: 'review', label: 'Review & Submit' },
    { id: 'success', label: 'Submitted' },
  ];
  const activeIdx = steps.findIndex((s) => s.id === step);

  return (
    <div className="flex items-center gap-0 mb-6">
      {steps.map((s, i) => {
        const isDone = i < activeIdx;
        const isActive = i === activeIdx;
        return (
          <div key={s.id} className="flex items-center flex-1 last:flex-none">
            <div className="flex items-center gap-2 shrink-0">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                isDone ? 'bg-emerald-600 text-white' : isActive ? 'bg-emerald-600 text-white ring-4 ring-emerald-500/20' : 'bg-muted text-muted-foreground'
              }`}>
                {isDone ? '✓' : i + 1}
              </div>
              <span className={`text-xs font-semibold whitespace-nowrap ${isActive ? 'text-emerald-700 dark:text-emerald-400' : isDone ? 'text-emerald-600/70 dark:text-emerald-500/70' : 'text-muted-foreground'}`}>
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className={`flex-1 h-px mx-3 transition-colors ${isDone ? 'bg-emerald-500/50' : 'bg-border/60'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Section label helper ──────────────────────────────────────────────────────
function SectionLabel({ icon: Icon, label }: { icon: any; label: string }) {
  return (
    <div className="flex items-center gap-2 mb-3 pb-2 border-b border-border/50">
      <div className="p-1.5 rounded-md bg-emerald-100 dark:bg-emerald-950/40">
        <Icon className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
      </div>
      <span className="text-sm font-semibold text-foreground">{label}</span>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="text-sm font-medium text-foreground">{value}</div>
    </div>
  );
}

// ── Main form component ───────────────────────────────────────────────────────
const SUBMIT_TIMEOUT_MS = 25_000;

export function ProjectSubmissionForm({ onSuccess }: ProjectSubmissionFormProps) {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [step, setStep] = useState<'edit' | 'review' | 'success'>('edit');
  const [fieldEvidenceFile, setFieldEvidenceFile] = useState<File | null>(null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [derivedArea, setDerivedArea] = useState<number>(0);
  const [createdProject, setCreatedProject] = useState<any>(null);
  const [boundaryPreviewUrl, setBoundaryPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(contributorSubmissionSchema),
    defaultValues: {
      name: '',
      description: '',
      restorationObjective: '',
      organizationName: '',
      restorationNotes: '',
      monitoringFrequency: 'monthly',
      ecosystemType: '',
      landBoundary: [],
    },
  });

  const landBoundaryRaw = useWatch({ control: form.control, name: 'landBoundary' });
  const landBoundary = (landBoundaryRaw as LatLng[]) ?? [];
  const monitoringFrequency = useWatch({ control: form.control, name: 'monitoringFrequency' });
  const ecosystemType = useWatch({ control: form.control, name: 'ecosystemType' });

  const handleBoundaryChange = (boundary: LatLng[], areaHectares: number) => {
    form.setValue('landBoundary', boundary, { shouldValidate: true });
    setDerivedArea(areaHectares);
  };

  const handleNextStep = async () => {
    setSubmissionError(null);
    const isValid = await form.trigger();
    if (!isValid) {
      const errors = form.formState.errors;
      const firstMsg = errors.name?.message ?? errors.ecosystemType?.message ?? errors.monitoringFrequency?.message
        ?? errors.description?.message ?? errors.restorationObjective?.message
        ?? (errors.landBoundary as any)?.message ?? 'Please correct all errors before continuing.';
      toast({ variant: 'destructive', title: 'Validation failed', description: firstMsg });
      return;
    }
    setBoundaryPreviewUrl(null);
    setPreviewLoading(true);
    setStep('review');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // Generate satellite preview async — review step shown immediately
    const { name } = form.getValues();
    generateSatellitePreview(landBoundary, name, derivedArea)
      .then((url) => setBoundaryPreviewUrl(url))
      .catch(() => { /* preview is non-critical — page stays functional without it */ })
      .finally(() => setPreviewLoading(false));
  };

  const submitMutation = useMutation({
    mutationFn: async (data: FormValues) => {
      // ── DIAGNOSTIC BLOCK (temporary) ───────────────────────────────────────
      console.error('PROJECT_SUBMISSION_DEBUG', {
        userId: '(client — see JWT)',
        payload: {
          name: data.name,
          name_length: data.name?.length,
          description_length: data.description?.length,
          restorationObjective_length: data.restorationObjective?.length,
          organizationName: data.organizationName,
          monitoringFrequency: data.monitoringFrequency,
          ecosystemType: data.ecosystemType,
          landBoundary_isArray: Array.isArray(data.landBoundary),
          landBoundary_count: Array.isArray(data.landBoundary) ? data.landBoundary.length : null,
          landBoundary_firstPoint: Array.isArray(data.landBoundary) ? data.landBoundary[0] : null,
          derivedArea,
          hasFile: Boolean(fieldEvidenceFile),
        },
        validationErrors: null,
        requestBody: '(sent as FormData — see server log)',
      });
      // ───────────────────────────────────────────────────────────────────────

      const formData = new FormData();
      formData.append('name', data.name.trim());
      formData.append('description', data.description.trim());
      formData.append('restorationObjective', data.restorationObjective.trim());
      formData.append('organizationName', data.organizationName?.trim() ?? '');
      formData.append('restorationNotes', data.restorationNotes?.trim() ?? '');
      formData.append('monitoringFrequency', data.monitoringFrequency);
      formData.append('ecosystemType', data.ecosystemType);
      formData.append('landBoundary', JSON.stringify(data.landBoundary));
      if (derivedArea > 0) formData.append('area', String(derivedArea));
      if (fieldEvidenceFile) formData.append('fieldEvidence', fieldEvidenceFile);

      const res = await Promise.race([
        apiRequest('POST', '/api/projects', formData),
        new Promise<Response>((_, reject) =>
          setTimeout(() => reject(new Error(`Submission timed out after ${SUBMIT_TIMEOUT_MS / 1000}s`)), SUBMIT_TIMEOUT_MS),
        ),
      ]);
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error ?? `Server error ${res.status}`); }
      return await res.json();
    },
    onSuccess: (data) => {
      setSubmissionError(null);
      setCreatedProject(data);
      setStep('success');
    },
    onError: (error: Error) => {
      const raw = error?.message ?? '';
      const isAuthError =
        raw.includes('account could not be located') ||
        raw.includes('sign in again') ||
        raw.includes('USER_NOT_FOUND');
      const message = isAuthError
        ? 'Unable to submit project. Please try signing in again or contact support.'
        : safeErrorMsg(error, 'Submission failed. Please check your details and try again.');
      setSubmissionError(message);
      toast({ variant: 'destructive', title: 'Submission failed', description: message });
    },
  });

  const onSubmit = (data: FormValues) => {
    setSubmissionError(null);
    if (!data.landBoundary || data.landBoundary.length < 3) {
      form.setError('landBoundary', { type: 'manual', message: 'Please draw a valid polygon boundary' });
      return;
    }
    submitMutation.mutate(data);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast({ variant: 'destructive', title: 'File too large', description: 'Supporting documents must be under 10MB' });
      return;
    }
    setFieldEvidenceFile(file);
  };

  const resetForm = () => {
    form.reset();
    setFieldEvidenceFile(null);
    setDerivedArea(0);
    setStep('edit');
    setCreatedProject(null);
    setBoundaryPreviewUrl(null);
  };

  const centroid = landBoundary.length >= 3 ? getCentroid(landBoundary) : null;
  const perimeter = landBoundary.length >= 3 ? calculatePerimeterKm(landBoundary) : 0;

  // ── Success step ─────────────────────────────────────────────────────────
  if (step === 'success' && createdProject) {
    return (
      <div className="space-y-6">
        <StepIndicator step="success" />
        <div className="flex flex-col items-center text-center py-4 gap-4">
          <div className="w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-950/40 flex items-center justify-center">
            <BadgeCheck className="w-9 h-9 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div>
            <h3 className="text-xl font-bold text-foreground">Project Submitted Successfully</h3>
            <p className="text-sm text-muted-foreground mt-1">Your project has entered the verification intake queue.</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="bg-muted/30 border border-border/50 rounded-lg p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Project ID</p>
            <p className="font-mono text-xs text-foreground font-semibold break-all">{createdProject.id ?? '—'}</p>
          </div>
          <div className="bg-muted/30 border border-border/50 rounded-lg p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Submitted</p>
            <p className="text-xs text-foreground font-semibold">
              {createdProject.createdAt
                ? new Date(createdProject.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
                : new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
            </p>
          </div>
          <div className="bg-muted/30 border border-border/50 rounded-lg p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Status</p>
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
              <CalendarClock className="w-3.5 h-3.5" /> Pending Verification
            </span>
          </div>
          <div className="bg-muted/30 border border-border/50 rounded-lg p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Est. Review</p>
            <p className="text-xs text-foreground font-semibold">3 – 5 business days</p>
          </div>
        </div>

        <div className="flex flex-col gap-2 pt-2">
          {createdProject.id && (
            <Button
              type="button"
              className="w-full h-11 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 font-semibold"
              onClick={() => {
                onSuccess(createdProject);
                setLocation(`/operations/project/${createdProject.id}`);
              }}
            >
              <LayoutGrid className="w-4 h-4 mr-2" /> View Project Intelligence Hub
            </Button>
          )}
          <Button type="button" variant="outline" className="w-full h-10 font-semibold" onClick={() => onSuccess(createdProject)}>
            <ArrowLeft className="w-4 h-4 mr-2" /> Return to Dashboard
          </Button>
          <Button type="button" variant="ghost" className="w-full h-9 text-sm text-muted-foreground" onClick={resetForm}>
            <RefreshCw className="w-3.5 h-3.5 mr-2" /> Submit Another Project
          </Button>
        </div>
      </div>
    );
  }

  // ── Review step ───────────────────────────────────────────────────────────
  if (step === 'review') {
    const values = form.getValues();
    const monLabel = MONITORING_OPTIONS.find((o) => o.value === values.monitoringFrequency)?.label ?? values.monitoringFrequency;
    const fileCount = fieldEvidenceFile ? 1 : 0;
    const isImage = fieldEvidenceFile && /\.(png|jpg|jpeg)$/i.test(fieldEvidenceFile.name);

    const checks = [
      { label: 'Required fields completed', ok: !!values.name && !!values.description && !!values.restorationObjective },
      { label: 'Ecosystem type selected', ok: !!values.ecosystemType },
      { label: 'Boundary validated', ok: landBoundary.length >= 3 },
      { label: 'Area calculated', ok: derivedArea > 0 },
      { label: 'Ready for verification intake', ok: true },
    ];

    return (
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <StepIndicator step="review" />

        {submissionError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />{submissionError}
          </div>
        )}

        {/* Project Information */}
        <div className="border border-border/60 rounded-xl p-4 space-y-4 bg-card">
          <SectionLabel icon={FileText} label="Project Information" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <ReviewRow label="Project Name" value={values.name} />
            <ReviewRow label="Ecosystem Type" value={
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/40">
                <Leaf className="w-3 h-3" />{values.ecosystemType}
              </span>
            } />
            <ReviewRow label="Monitoring Frequency" value={
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-400 border border-blue-100 dark:border-blue-800/30 uppercase tracking-wide">
                <Clock3 className="w-3 h-3" />{monLabel}
              </span>
            } />
            {values.organizationName && (
              <ReviewRow label="Organisation" value={values.organizationName} />
            )}
          </div>
          <ReviewRow label="Description" value={<span className="text-sm text-foreground/80 leading-relaxed">{values.description}</span>} />
          <ReviewRow label="Restoration Objective" value={<span className="text-sm text-foreground/80 leading-relaxed">{values.restorationObjective}</span>} />
          {values.restorationNotes && (
            <ReviewRow label="Additional Notes" value={<span className="text-sm text-foreground/70 italic">"{values.restorationNotes}"</span>} />
          )}
        </div>

        {/* Boundary Information */}
        <div className="border border-border/60 rounded-xl p-4 space-y-4 bg-card">
          <SectionLabel icon={MapPin} label="Boundary Information" />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200/60 dark:border-emerald-800/30 rounded-lg p-3 col-span-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-600/70 dark:text-emerald-500/70 mb-1">Area</p>
              <p className="text-2xl font-black text-emerald-700 dark:text-emerald-300">
                {derivedArea.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span className="text-xs font-semibold">ha</span>
              </p>
            </div>
            <div className="bg-muted/30 border border-border/40 rounded-lg p-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Perimeter</p>
              <p className="text-sm font-bold text-foreground">{perimeter} km</p>
            </div>
            <div className="bg-muted/30 border border-border/40 rounded-lg p-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Vertices</p>
              <p className="text-sm font-bold text-foreground">{landBoundary.length}</p>
            </div>
            {centroid && (
              <div className="bg-muted/30 border border-border/40 rounded-lg p-3 col-span-2 sm:col-span-4">
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Centre Coordinate</p>
                <p className="font-mono text-xs text-foreground">{centroid.lat.toFixed(6)}°, {centroid.lng.toFixed(6)}°</p>
              </div>
            )}
          </div>

          {/* Satellite boundary preview */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Project Boundary Preview</p>
            {previewLoading ? (
              <SatellitePreviewSkeleton />
            ) : boundaryPreviewUrl ? (
              <div className="rounded-xl overflow-hidden border border-border/40">
                <img
                  src={boundaryPreviewUrl}
                  alt="Satellite boundary preview"
                  className="w-full block"
                  style={{ height: 220, objectFit: 'cover' }}
                />
              </div>
            ) : (
              <div className="rounded-xl overflow-hidden border border-border/40 bg-[#1a2035] flex items-center justify-center" style={{ height: 220 }}>
                <p className="text-xs text-muted-foreground">Satellite preview unavailable</p>
              </div>
            )}
          </div>
        </div>

        {/* Supporting Evidence */}
        <div className="border border-border/60 rounded-xl p-4 space-y-3 bg-card">
          <SectionLabel icon={BarChart2} label="Supporting Evidence" />
          {fieldEvidenceFile ? (
            <div className="flex items-center gap-3 p-3 bg-muted/20 border border-border/40 rounded-lg">
              <FileText className="w-5 h-5 text-emerald-600 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold truncate">{fieldEvidenceFile.name}</p>
                <p className="text-xs text-muted-foreground">{(fieldEvidenceFile.size / (1024 * 1024)).toFixed(2)} MB · {isImage ? 'Image' : 'Document'}</p>
              </div>
              <div className="text-[10px] font-bold text-emerald-600 bg-emerald-100 dark:bg-emerald-950/30 px-2 py-0.5 rounded-full">{fileCount} file</div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic">No supporting document uploaded</p>
          )}
        </div>

        {/* Submission Checklist */}
        <div className="border border-border/60 rounded-xl p-4 space-y-3 bg-card">
          <SectionLabel icon={CheckCircle} label="Submission Checklist" />
          <div className="space-y-2">
            {checks.map(({ label, ok }) => (
              <div key={label} className="flex items-center gap-2.5">
                <div className={`w-4.5 h-4.5 rounded-full flex items-center justify-center shrink-0 ${ok ? 'text-emerald-600' : 'text-amber-500'}`}>
                  {ok ? <CheckCircle className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                </div>
                <span className={`text-sm ${ok ? 'text-foreground' : 'text-amber-600 dark:text-amber-400'}`}>{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3 pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => { setStep('edit'); setBoundaryPreviewUrl(null); }}
            className="flex-1 h-12 font-semibold"
            disabled={submitMutation.isPending}
          >
            <ArrowLeft className="w-4 h-4 mr-2" /> Back to Edit
          </Button>
          <Button
            type="submit"
            className="flex-[2] h-12 text-base bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 font-semibold shadow-md"
            disabled={submitMutation.isPending}
          >
            {submitMutation.isPending ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Submitting…</>
            ) : (
              <><CheckCircle className="w-4 h-4 mr-2" />Confirm & Submit Project</>
            )}
          </Button>
        </div>
      </form>
    );
  }

  // ── Edit step (default) ───────────────────────────────────────────────────
  return (
    <form onSubmit={(e) => e.preventDefault()} className="space-y-6">
      <StepIndicator step="edit" />

      {submissionError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />{submissionError}
        </div>
      )}

      {/* Project Name */}
      <div className="space-y-1.5">
        <Label htmlFor="name" className="font-semibold">Project Name <span className="text-destructive">*</span></Label>
        <Input
          id="name"
          {...form.register('name')}
          placeholder="Kandla Coastal Mangrove Restoration"
          className={form.formState.errors.name ? 'border-destructive' : ''}
        />
        {form.formState.errors.name && (
          <p className="text-sm text-destructive flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />{form.formState.errors.name.message}
          </p>
        )}
      </div>

      {/* Ecosystem + Monitoring grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="ecosystemType" className="font-semibold flex items-center gap-1.5">
            <Leaf className="w-3.5 h-3.5 text-emerald-500" />Ecosystem Type <span className="text-destructive">*</span>
          </Label>
          <Select
            value={ecosystemType}
            onValueChange={(v) => form.setValue('ecosystemType', v, { shouldValidate: true })}
          >
            <SelectTrigger id="ecosystemType" className={form.formState.errors.ecosystemType ? 'border-destructive' : ''}>
              <SelectValue placeholder="Select Ecosystem Type" />
            </SelectTrigger>
            <SelectContent>
              {ECOSYSTEM_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Choose the ecosystem that best represents the project area. This can be refined during verification.
          </p>
          {form.formState.errors.ecosystemType && (
            <p className="text-sm text-destructive flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />{form.formState.errors.ecosystemType.message}
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="monitoringFrequency" className="font-semibold flex items-center gap-1.5">
            <Clock3 className="w-3.5 h-3.5 text-emerald-500" />Monitoring Frequency <span className="text-destructive">*</span>
          </Label>
          <Select
            value={monitoringFrequency}
            onValueChange={(v) => form.setValue('monitoringFrequency', v as FormValues['monitoringFrequency'])}
          >
            <SelectTrigger id="monitoringFrequency">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MONITORING_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  <span className="font-medium">{opt.label}</span>
                  <span className="text-muted-foreground ml-2 text-xs">{opt.desc}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Description */}
      <div className="space-y-1.5">
        <Label htmlFor="description" className="font-semibold">Project Description <span className="text-destructive">*</span></Label>
        <Textarea
          id="description"
          {...form.register('description')}
          placeholder="Describe the restoration context, baseline ecological condition, and scope of the intervention area."
          rows={4}
          className={form.formState.errors.description ? 'border-destructive' : ''}
        />
        {form.formState.errors.description && (
          <p className="text-sm text-destructive flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />{form.formState.errors.description.message}
          </p>
        )}
      </div>

      {/* Restoration Objective */}
      <div className="space-y-1.5">
        <Label htmlFor="restorationObjective" className="font-semibold">Restoration Objective <span className="text-destructive">*</span></Label>
        <Textarea
          id="restorationObjective"
          {...form.register('restorationObjective')}
          placeholder="Example: recover tidal mangrove belt and reduce shoreline erosion by 40% over 5 years."
          rows={3}
          className={form.formState.errors.restorationObjective ? 'border-destructive' : ''}
        />
        {form.formState.errors.restorationObjective && (
          <p className="text-sm text-destructive flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />{form.formState.errors.restorationObjective.message}
          </p>
        )}
      </div>

      {/* Organisation + Notes */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="organizationName" className="font-semibold flex items-center gap-1.5">
            <Building className="w-3.5 h-3.5 text-muted-foreground" />Organisation Name <span className="text-xs text-muted-foreground font-normal">(optional)</span>
          </Label>
          <Input id="organizationName" {...form.register('organizationName')} placeholder="Blue Coast Foundation" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="restorationNotes" className="font-semibold">Restoration Notes <span className="text-xs text-muted-foreground font-normal">(optional)</span></Label>
          <Input id="restorationNotes" {...form.register('restorationNotes')} placeholder="Species, timeline, planting density, etc." />
        </div>
      </div>

      {/* GIS Boundary Map */}
      <div className="space-y-2">
        <Label className="font-semibold flex items-center gap-1.5">
          <MapPin className="w-3.5 h-3.5 text-emerald-500" />Polygon Boundary <span className="text-destructive">*</span>
        </Label>
        <Suspense fallback={
          <div className="h-[400px] flex items-center justify-center border rounded-xl bg-muted/30">
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Loader2 className="w-8 h-8 animate-spin" />
              <span className="text-sm">Loading map…</span>
            </div>
          </div>
        }>
          <GISLandMap onBoundaryChange={handleBoundaryChange} readOnly={false} initialBoundary={landBoundary} />
        </Suspense>
        {form.formState.errors.landBoundary && (
          <p className="text-sm text-destructive flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />{(form.formState.errors.landBoundary as any).message}
          </p>
        )}
        {landBoundary.length > 2 && (
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-50/50 dark:bg-emerald-950/20 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400 font-semibold flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            GIS boundary captured · {landBoundary.length} vertices · {derivedArea.toFixed(2)} ha
          </div>
        )}
      </div>

      {/* Field Evidence Upload */}
      <div className="space-y-1.5">
        <Label htmlFor="field-evidence" className="font-semibold">
          Supporting Documents / Field Evidence <span className="text-xs text-muted-foreground font-normal">(optional)</span>
        </Label>
        <div className="group relative border-2 border-dashed border-border/60 rounded-xl p-5 transition-colors hover:border-emerald-500/40 bg-muted/10 hover:bg-emerald-50/20 dark:hover:bg-emerald-950/10">
          <Input
            id="field-evidence"
            type="file"
            onChange={handleFileChange}
            accept=".pdf,.png,.jpg,.jpeg,.doc,.docx"
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
          <div className="flex flex-col items-center gap-1.5 text-center pointer-events-none">
            <Upload className="w-7 h-7 text-muted-foreground/50 group-hover:text-emerald-500 transition-colors" />
            <p className="text-sm font-medium text-foreground">
              {fieldEvidenceFile ? fieldEvidenceFile.name : 'Click or drag to upload field evidence'}
            </p>
            <p className="text-xs text-muted-foreground">PDF, JPG, PNG, DOC, DOCX · Max 10MB</p>
          </div>
        </div>
      </div>

      {/* Continue button */}
      <Button
        type="button"
        onClick={handleNextStep}
        className="w-full h-12 text-base bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 font-semibold shadow"
      >
        Continue to Review <ArrowRight className="w-4 h-4 ml-2" />
      </Button>
    </form>
  );
}
