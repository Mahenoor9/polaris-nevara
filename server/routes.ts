import type { Express } from "express";
import axios from "axios";
import { createServer, type Server } from "http";
import bcrypt from "bcryptjs";
import multer from "multer";
import { storage } from "./storage";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";
import { loginSchema, signupSchema, projectReviewSchema, AUDIT_ACTION_TYPES, ECOSYSTEM_TYPES, reviewCommentSchema, clarificationRequestSchema, clarificationResponseSchema, type Project } from "@shared/schema";
import { reviewService, type Attachment } from "./reviews/review-service";
import { reviewRepository } from "./reviews/review-repository";


import { generateToken, requireAuth, requireRole, type AuthRequest } from "./auth";
import {
  computeTransactionId,
  computeProofHash,
  computeMerkleRoot,
  computeBlockHash,
  generateValidatorSignature,
} from "./blockchain";
import { sha256 } from "js-sha256";
import { calculateCarbonSequestration } from "./carbonCalculation";
import { audit } from "./auditLog";
import { parsePolygonFromLandBoundary } from "./gis/polygon-ingestion";
import { validatePolygonGeometry } from "./gis/geometry-validation";
import { gisEnrichmentService } from "./gis/gis-enrichment-service";
import { ecologicalInitializationService } from "./ecology/ecological-initialization-service";
import { monitoringOrchestratorService } from "./mrv/monitoring-orchestrator";
import { verifierWorkflowService } from "./verifier/verifier-workflow-service";

import { registerProjectSubscriber, registerAdminSubscriber, pushAuditEvent } from "./realtime/sse-manager";
import { getLivenessResult, getFullHealthResult, getOpsStatus } from "./observability/health-service";
import { appendAuditEvent, getRecentEvents, getEventStats, auditEventEmitter } from "./observability/audit-event-store";
import { getPerformanceSummary } from "./observability/performance-profiler";
import { runAssetCleanup } from "./observability/asset-retention";
import { evidenceService } from "./evidence/evidenceService";

import { evidenceExportService } from "./gee/evidence-export-service";
import { emailService } from "./notifications/email-service";
import {
  deriveScheduleSnapshots,
  buildCalendarEvents,
  buildMonitoringQueue,
  buildMonitoringSummary,
  selectDueForExecution,
  normalizeFrequency,
  computeNextMonitoringDate,
  MONITORING_FREQUENCIES,
} from "./scheduler/monitoring-schedule-service";
import rateLimit from "express-rate-limit";
import { z } from "zod";

// UUID validation regex - matches standard UUID format
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isValidUUID = (id: string): boolean => UUID_REGEX.test(id);

// ─── Async Error Wrapper ────────────────────────────────────────────────────────────
// Wraps async route handlers to forward errors to Express error handler
// This prevents unhandled promise rejections and ensures consistent error responses
function asyncHandler(
  fn: (req: any, res: any, next: any) => Promise<any>
) {
  return (req: any, res: any, next: any) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ─── Configure multer ─────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB hard cap
});

// ─── Account Lockout Store (Task 1.1) ─────────────────────────────────────────
// In-memory store: email → { count, lockedUntil }
// This is intentionally in-memory so it resets on server restart (acceptable for
// a single-instance deployment; replace with Redis for multi-instance).
interface LockoutEntry {
  count: number;
  lockedUntil: number | null; // Unix timestamp ms, null = not locked
}

const loginAttempts = new Map<string, LockoutEntry>();

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

function getLoginAttempts(email: string): LockoutEntry {
  return loginAttempts.get(email) ?? { count: 0, lockedUntil: null };
}

function recordFailedAttempt(email: string): LockoutEntry {
  const entry = getLoginAttempts(email);
  const newCount = entry.count + 1;
  const lockedUntil =
    newCount >= MAX_FAILED_ATTEMPTS ? Date.now() + LOCKOUT_DURATION_MS : null;
  const updated: LockoutEntry = { count: newCount, lockedUntil };
  loginAttempts.set(email, updated);
  return updated;
}

function resetLoginAttempts(email: string): void {
  loginAttempts.delete(email);
}

function isAccountLocked(email: string): { locked: boolean; remainingMs: number } {
  const entry = getLoginAttempts(email);
  if (!entry.lockedUntil) return { locked: false, remainingMs: 0 };
  const remaining = entry.lockedUntil - Date.now();
  if (remaining <= 0) {
    // Lock has expired — reset
    loginAttempts.delete(email);
    return { locked: false, remainingMs: 0 };
  }
  return { locked: true, remainingMs: remaining };
}

// ─── In-Memory Cache (Task 7.3) ───────────────────────────────────────────────
// Simple TTL cache for high-traffic read endpoints.
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class SimpleCache {
  private store = new Map<string, CacheEntry<any>>();

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.data as T;
  }

  set<T>(key: string, data: T, ttlMs: number): void {
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  invalidatePattern(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }
}

const cache = new SimpleCache();
const CACHE_TTL_REGISTRY = 60 * 1000;  // 60 seconds
const CACHE_TTL_STATS = 5 * 60 * 1000;    // 5 minutes
const PROJECT_SUBMIT_INIT_TIMEOUT_MS = 12_000;
const PROJECT_SUBMIT_DB_TIMEOUT_MS = 10_000;
const PROJECT_SUBMIT_MINIMAL_MODE = true;
const PROJECT_SUBMIT_ULTRA_MINIMAL_MODE = true;

const contributorSubmissionSchema = z.object({
  name: z.string().min(3, "Project name must be at least 3 characters"),
  description: z.string().min(10, "Project description must be at least 10 characters"),
  restorationObjective: z.string().min(5, "Restoration objective is required"),
  organizationName: z.string().optional(),
  restorationNotes: z.string().optional(),
  location: z.string().optional(),
  landBoundary: z.string().min(1, "Polygon boundary is required"),
  monitoringFrequency: z.enum(["biweekly", "monthly", "quarterly"]).optional(),
  ecosystemType: z.enum(ECOSYSTEM_TYPES).optional(),
  area: z.coerce.number().positive().optional(),
});

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T>([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function registerRoutes(app: Express): Promise<Server> {

  // ─── HEALTH CHECK (Task 5.2) ────────────────────────────────────────────────
  app.get("/health", async (_req, res) => {
    try {
      // Verify DB connectivity by running a lightweight query
      await storage.getAllUsers();
      return res.json({
        status: "ok",
        db: "connected",
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || "development",
      });
    } catch (err: any) {
      return res.status(503).json({
        status: "degraded",
        db: "error",
        error: err.message,
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ─── AUTH ROUTES - Public ───────────────────────────────────────────────────
  app.post("/api/auth/login", async (req, res) => {
    try {
      const { email, password } = loginSchema.parse(req.body);
      const ip = req.ip ?? req.socket?.remoteAddress ?? "unknown";

      // ── Account Lockout Check (Task 1.1) ──────────────────────────────────
      const lockStatus = isAccountLocked(email);
      if (lockStatus.locked) {
        const remainingMinutes = Math.ceil(lockStatus.remainingMs / 60000);
        // Audit: account was locked when login was attempted
        await audit({
          userId: null,
          actionType: AUDIT_ACTION_TYPES.ACCOUNT_LOCKED,
          entityType: "user",
          entityId: null,
          metadata: { email, ip, remainingMs: lockStatus.remainingMs },
        });
        return res.status(429).json({
          error: `Account temporarily locked due to too many failed login attempts. Try again in ${remainingMinutes} minute(s).`,
          lockedFor: lockStatus.remainingMs,
        });
      }

      const user = await storage.getUserByEmail(email);

      if (!user) {
        recordFailedAttempt(email);
        // Audit: login failure (unknown email)
        await audit({
          userId: null,
          actionType: AUDIT_ACTION_TYPES.LOGIN_FAILURE,
          entityType: "user",
          entityId: null,
          metadata: { email, ip, reason: "user_not_found" },
        });
        return res.status(401).json({ error: "Invalid email or password" });
      }

      // Compare hashed passwords
      const isValid = await bcrypt.compare(password, user.password);
      if (!isValid) {
        const attempt = recordFailedAttempt(email);
        const remaining = MAX_FAILED_ATTEMPTS - attempt.count;
        const isNowLocked = attempt.count >= MAX_FAILED_ATTEMPTS;
        // Audit: login failure (wrong password) — also log if account just got locked
        await audit({
          userId: user.id,
          actionType: isNowLocked
            ? AUDIT_ACTION_TYPES.ACCOUNT_LOCKED
            : AUDIT_ACTION_TYPES.LOGIN_FAILURE,
          entityType: "user",
          entityId: user.id,
          metadata: {
            ip,
            failedAttempts: attempt.count,
            reason: "invalid_password",
            accountLocked: isNowLocked,
          },
        });
        const message = isNowLocked
          ? "Account locked for 15 minutes due to too many failed attempts."
          : `Invalid email or password. ${remaining} attempt(s) remaining before lockout.`;
        return res.status(401).json({ error: message });
      }

      // Successful login — reset lockout counter
      resetLoginAttempts(email);

      // Audit: successful login
      await audit({
        userId: user.id,
        actionType: AUDIT_ACTION_TYPES.LOGIN_SUCCESS,
        entityType: "user",
        entityId: user.id,
        metadata: { ip, role: user.role },
      });

      // Generate JWT token
      const token = generateToken(user);
      const { password: _, ...userWithoutPassword } = user;

      return res.json({
        message: "Login successful",
        token,
        user: userWithoutPassword,
      });
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/auth/signup", async (req, res) => {
    try {
      const data = signupSchema.parse(req.body);
      const existing = await storage.getUserByEmail(data.email);

      if (existing) {
        return res.status(400).json({ error: "Email already registered" });
      }

      // Create user with hashed password
      const user = await storage.createUser(data);
      const token = generateToken(user);
      const { password: _, ...userWithoutPassword } = user;

      // Audit: new user signup
      await audit({
        userId: user.id,
        actionType: AUDIT_ACTION_TYPES.SIGNUP,
        entityType: "user",
        entityId: user.id,
        metadata: { role: user.role, ip: req.ip ?? "unknown" },
      });

      return res.json({
        message: "Account created successfully",
        token,
        user: userWithoutPassword,
      });
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.get("/api/auth/profile", requireAuth, async (req: AuthRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const user = await storage.getUser(req.user.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      const { password: _, ...userWithoutPassword } = user;
      return res.json(userWithoutPassword);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/debug/users", requireAuth, requireRole('admin'), async (req: AuthRequest, res) => {
    try {
      const allUsers = await storage.getAllUsers();
      return res.json(allUsers.map(u => {
        const { password: _, ...rest } = u;
        return rest;
      }));
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });

  // ─── ROLE CHANGE ROUTE (ADMIN ONLY) ───────────────────────────────────────────
  app.patch("/api/users/:id/role", requireAuth, requireRole('admin'), async (req: AuthRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const { id } = req.params;
      const { role } = req.body;

      // Validate role
      const allowedRoles = ['admin', 'verifier', 'contributor'];
      if (!role || !allowedRoles.includes(role)) {
        return res.status(400).json({
          error: `Invalid role. Allowed roles: ${allowedRoles.join(', ')}`
        });
      }

      // Get existing user
      const existingUser = await storage.getUser(id);
      if (!existingUser) {
        return res.status(404).json({ error: "User not found" });
      }

      const oldRole = existingUser.role;

      // Don't allow changing own role (prevent lockout)
      if (id === req.user.id) {
        return res.status(400).json({ error: "Cannot change your own role" });
      }

      // Update user role
      const updatedUser = await storage.updateUser(id, { role });
      if (!updatedUser) {
        return res.status(500).json({ error: "Failed to update user role" });
      }

      // Audit: role changed
      await audit({
        userId: req.user.id,
        actionType: AUDIT_ACTION_TYPES.ROLE_CHANGED,
        entityType: "user",
        entityId: id,
        metadata: {
          targetUserEmail: existingUser.email,
          oldRole,
          newRole: role,
        },
      });

      return res.json({
        message: "Role updated successfully",
        user: { ...updatedUser, password: undefined }
      });
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.get("/api/stats", async (_req, res) => {
    try {
      // ── Cached stats (Task 7.3) ──────────────────────────────────────────
      const CACHE_KEY = "stats:global";
      const cached = cache.get<object>(CACHE_KEY);
      if (cached) return res.json(cached);

      const projects = await storage.getAllProjects();
      const totalProjects = projects.length;
      const verifiedProjects = projects.filter(p => p.status === "verified").length;
      const totalCO2Captured = projects
        .filter(p => p.status === "verified")
        .reduce((sum, p) => sum + p.co2Captured, 0);
      const totalAreaHa = projects.reduce((sum, p) => sum + Number(p.area || 0), 0);

      const result = { totalProjects, verifiedProjects, totalCO2Captured, totalAreaHa };
      cache.set(CACHE_KEY, result, CACHE_TTL_STATS);
      return res.json(result);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });

  // PROJECT SUBMISSION - Protected route with ecological-first contract
  app.post("/api/projects", requireAuth, upload.any(), async (req: AuthRequest, res) => {
    const requestStartedAt = Date.now();
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      console.log("[ProjectSubmit] request received", {
        userId: req.user.id,
        contentType: req.headers["content-type"],
      });

      const body = req.body ?? {};

      // ── DIAGNOSTIC BLOCK (temporary) ─────────────────────────────────────────
      const rawPayload = {
        name: body.name,
        description_length: typeof body.description === "string" ? body.description.length : body.description,
        restorationObjective_length: typeof body.restorationObjective === "string" ? body.restorationObjective.length : body.restorationObjective,
        organizationName: body.organizationName,
        restorationNotes_length: typeof body.restorationNotes === "string" ? body.restorationNotes.length : null,
        location: body.location,
        ecosystemType: body.ecosystemType,
        monitoringFrequency: body.monitoringFrequency,
        area: body.area,
        landBoundary_type: typeof body.landBoundary,
        landBoundary_length: typeof body.landBoundary === "string" ? body.landBoundary.length : null,
        landBoundary_preview: typeof body.landBoundary === "string" ? body.landBoundary.slice(0, 120) : String(body.landBoundary).slice(0, 120),
        allBodyKeys: Object.keys(body),
      };
      console.error("PROJECT_SUBMISSION_DEBUG", {
        userId: req.user.id,
        requestBody: rawPayload,
        payload: null,
        validationErrors: null,
      });
      // ─────────────────────────────────────────────────────────────────────────

      const validationStartedAt = Date.now();

      // Validate per-field via safeParse so we can log the exact failing field
      const zodInput = {
        name: body.name,
        description: body.description,
        restorationObjective: body.restorationObjective ?? body.description,
        organizationName: body.organizationName,
        restorationNotes: body.restorationNotes,
        location: body.location,
        landBoundary: body.landBoundary,
        monitoringFrequency: body.monitoringFrequency,
        ecosystemType: body.ecosystemType,
        area: body.area,
      };
      const zodResult = contributorSubmissionSchema.safeParse(zodInput);
      if (!zodResult.success) {
        const validationErrors = zodResult.error.errors.map((e) => ({
          field: e.path.join(".") || "(root)",
          message: e.message,
          code: e.code,
          received: (e as any).received,
          expected: (e as any).expected ?? (e as any).options,
        }));
        console.error("PROJECT_SUBMISSION_DEBUG", {
          userId: req.user.id,
          requestBody: rawPayload,
          payload: null,
          validationErrors,
        });
        throw zodResult.error;
      }
      const parsedSubmission = zodResult.data;
      console.error("PROJECT_SUBMISSION_DEBUG", {
        userId: req.user.id,
        requestBody: rawPayload,
        payload: {
          name: parsedSubmission.name,
          ecosystemType: parsedSubmission.ecosystemType,
          monitoringFrequency: parsedSubmission.monitoringFrequency,
          landBoundary_isString: typeof parsedSubmission.landBoundary === "string",
          landBoundary_length: parsedSubmission.landBoundary.length,
          restorationObjective_length: parsedSubmission.restorationObjective.length,
          description_length: parsedSubmission.description.length,
        },
        validationErrors: null,
      });
      console.log("[ProjectSubmit] validation passed", {
        userId: req.user.id,
        keys: Object.keys(body),
        validationMs: Date.now() - validationStartedAt,
      });

      const files = (req.files ?? []) as Express.Multer.File[];
      console.log("[ProjectSubmit] upload middleware completed", {
        userId: req.user.id,
        filesCount: files.length,
        totalMs: Date.now() - requestStartedAt,
      });
      const fieldEvidenceFile = files.find((file) => file.fieldname === "fieldEvidence");
      const legacyProofFile = files.find((file) => file.fieldname === "proof");
      const submissionAttachment = fieldEvidenceFile ?? legacyProofFile;

      console.log("[ProjectSubmit] Received submission", {
        userId: req.user.id,
        hasPolygon: Boolean(parsedSubmission.landBoundary),
        monitoringFrequency: parsedSubmission.monitoringFrequency ?? "monthly",
        fileField: submissionAttachment?.fieldname ?? null,
      });

      // Parse polygon and compute real GIS metrics immediately.
      let parsedPolygon: ReturnType<typeof parsePolygonFromLandBoundary>;
      try {
        parsedPolygon = parsePolygonFromLandBoundary(parsedSubmission.landBoundary);
        console.log("[ProjectSubmit] [GIS] polygon parsed", {
          points: parsedPolygon.polygon.coordinates?.[0]?.length ?? 0,
        });
      } catch (e) {
        console.error("[ProjectSubmit] polygon parse failed:", e);
        return res.status(400).json({ error: "Invalid polygon boundary format." });
      }

      // Synchronous GIS Geometry validation gate
      const validation = validatePolygonGeometry(parsedPolygon.polygon);
      if (!validation.valid) {
        console.warn("[ProjectSubmit] geometry validation failed:", validation.errors);
        return res.status(400).json({
          error: `Polygon validation failed: ${validation.errors.join(" ")}`
        });
      }

      // Compute real spatial metrics synchronously via turf (no network).
      const spatialMetrics = gisEnrichmentService.computeMetrics(parsedPolygon.polygon);
      const calculatedArea = spatialMetrics.areaHectares;
      console.log("[ProjectSubmit] [GIS] computed metrics", {
        areaHectares: spatialMetrics.areaHectares,
        perimeterKm: spatialMetrics.perimeterKm,
        centroid: spatialMetrics.centroid,
      });

      // Location: use user-supplied value if given, otherwise coordinate placeholder
      // (full reverse-geocoding runs in background after response).
      const coordinateFallback = `${spatialMetrics.centroid.lat.toFixed(4)}°, ${spatialMetrics.centroid.lng.toFixed(4)}°`;
      const location = parsedSubmission.location?.trim() ? parsedSubmission.location.trim() : coordinateFallback;
      const ecosystemType = parsedSubmission.ecosystemType ?? "Other";
      const monitoringFrequency = parsedSubmission.monitoringFrequency ?? "monthly";

      const descriptionSections = [
        parsedSubmission.description.trim(),
        `Restoration Objective: ${parsedSubmission.restorationObjective.trim()}`,
        parsedSubmission.organizationName?.trim() ? `Organization: ${parsedSubmission.organizationName.trim()}` : null,
        parsedSubmission.restorationNotes?.trim() ? `Restoration Notes: ${parsedSubmission.restorationNotes.trim()}` : null,
      ].filter((section): section is string => Boolean(section));
      const normalizedDescription = descriptionSections.join("\n\n");

      // Calculate carbon sequestration based on area, ecosystem, and location
      const { annualCO2, lifetimeCO2 } = calculateCarbonSequestration(
        calculatedArea,
        ecosystemType,
        location
      );

      // Handle optional field evidence/proof upload
      let proofFileUrl: string | null = null;
      let deferredEvidenceUpload:
        | {
            fileName: string;
            buffer: Buffer;
            mimetype: string;
          }
        | undefined;
      if (submissionAttachment) {
        // Validate file type
        const allowedMimeTypes = [
          'application/pdf',
          'image/jpeg',
          'image/jpg',
          'image/png',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // DOCX
          'application/msword', // DOC
        ];

        if (!allowedMimeTypes.includes(submissionAttachment.mimetype)) {
          return res.status(400).json({
            error: "Invalid file type. Only PDF, JPG, PNG, and DOCX files are allowed."
          });
        }

        // Check if object storage is configured
        const isObjectStorageConfigured = process.env.PRIVATE_OBJECT_DIR;

        if (isObjectStorageConfigured) {
          const fileName = `evidence-${Date.now()}-${submissionAttachment.originalname}`;
          if (PROJECT_SUBMIT_MINIMAL_MODE) {
            deferredEvidenceUpload = {
              fileName,
              buffer: submissionAttachment.buffer,
              mimetype: submissionAttachment.mimetype,
            };
            console.log("[ProjectSubmit] deferring evidence upload to background", {
              userId: req.user.id,
              fileName,
              bytes: submissionAttachment.size,
            });
          } else {
            try {
              const uploadStartedAt = Date.now();
              const objectStorage = new ObjectStorageService();
              const uploadedUrl = await objectStorage.uploadToPrivate(
                fileName,
                submissionAttachment.buffer,
                submissionAttachment.mimetype
              );
              proofFileUrl = uploadedUrl;
              console.log("[ProjectSubmit] evidence upload completed", {
                userId: req.user.id,
                uploadMs: Date.now() - uploadStartedAt,
              });
            } catch (uploadError: any) {
              console.error("File upload error:", uploadError);
              return res.status(500).json({
                error: uploadError.message || "Failed to upload proof document"
              });
            }
          }
        } else {
          // Object storage not configured - log warning and skip file upload
          console.warn("⚠️  Object storage not configured. Proof document will not be saved. To enable file uploads, set up object storage and configure PRIVATE_OBJECT_DIR environment variable.");
          // Leave proofFileUrl as null (already set in projectData initialization)
        }
      }

      // Verify the authenticated user actually exists in the database.
      // A valid JWT can reference a UUID from a previous MemStorage session that was
      // never written to PostgreSQL — the FK on projects.user_id fires in that case.
      const existingUser = await storage.getUser(req.user.id);
      if (!existingUser) {
        console.warn("[ProjectSubmit] JWT user not found in storage — stale session", {
          userId: req.user.id,
        });
        return res.status(400).json({
          error: "Your account could not be located. Please sign in again.",
          code: "USER_NOT_FOUND",
        });
      }

      // Create project with calculated carbon values and ecological-first defaults
      const projectWithCarbon = {
        name: parsedSubmission.name.trim(),
        description: normalizedDescription,
        location,
        area: calculatedArea,
        ecosystemType,
        userId: req.user.id,
        annualCO2,
        lifetimeCO2,
        co2Captured: lifetimeCO2, // Legacy field, same as lifetime
        landBoundary: parsedSubmission.landBoundary, // GIS polygon data
        ...(PROJECT_SUBMIT_ULTRA_MINIMAL_MODE
          ? {}
          : {
              proofFileUrl,
              monitoringFrequency,
              mrvStatus: "IDLE",
            }),
      };

      console.log("[ProjectSubmit] Persisting project", {
        userId: req.user.id,
        name: projectWithCarbon.name,
        area: projectWithCarbon.area,
        ecosystemType: projectWithCarbon.ecosystemType,
        minimalMode: PROJECT_SUBMIT_MINIMAL_MODE,
        ultraMinimalMode: PROJECT_SUBMIT_ULTRA_MINIMAL_MODE,
      });

      console.log("[ProjectSubmit] DB insert started", { userId: req.user.id });
      const t0Db = Date.now();
      const project = await withTimeout(
        storage.createProject(projectWithCarbon as any),
        PROJECT_SUBMIT_DB_TIMEOUT_MS,
        "project.create"
      );
      console.log("[ProjectSubmit] DB insert completed", {
        projectId: project.id,
        dbMs: Date.now() - t0Db,
      });

      console.log("[ProjectSubmit] Response sent — ecological init running in background", {
        projectId: project.id,
        status: project.status,
        totalMs: Date.now() - requestStartedAt,
      });

      // Defer all post-response work until the response is fully flushed.
      res.once("finish", () => {
        setImmediate(() => {
          void (async () => {
            if (deferredEvidenceUpload) {
              const uploadStartedAt = Date.now();
              try {
                console.log("[ProjectSubmit:BG] evidence upload started", {
                  projectId: project.id,
                  fileName: deferredEvidenceUpload.fileName,
                });
                const objectStorage = new ObjectStorageService();
                const uploadedUrl = await objectStorage.uploadToPrivate(
                  deferredEvidenceUpload.fileName,
                  deferredEvidenceUpload.buffer,
                  deferredEvidenceUpload.mimetype
                );
                await withTimeout(
                  storage.updateProject(project.id, { proofFileUrl: uploadedUrl }),
                  PROJECT_SUBMIT_DB_TIMEOUT_MS,
                  "project.updateProofFileUrl"
                );
                console.log("[ProjectSubmit:BG] evidence upload completed", {
                  projectId: project.id,
                  uploadMs: Date.now() - uploadStartedAt,
                });
              } catch (uploadErr) {
                console.warn("[ProjectSubmit:BG] evidence upload failed:", {
                  projectId: project.id,
                  error: (uploadErr as Error)?.message ?? String(uploadErr),
                  uploadMs: Date.now() - uploadStartedAt,
                });
              }
            }

            // ── GIS Enrichment: persist real spatial metrics + geocoded location ──
            try {
              console.log("[ProjectSubmit:BG] [GIS] starting full enrichment for project", project.id);
              const enrichment = await gisEnrichmentService.enrichPolygon(parsedPolygon.polygon);
              await storage.updateProject(project.id, {
                area: enrichment.areaHectares,
                areaHectares: enrichment.areaHectares,
                perimeterKm: enrichment.perimeterKm,
                centroid: JSON.stringify({ lat: enrichment.centroid.lat, lng: enrichment.centroid.lng }),
                bbox: JSON.stringify(enrichment.bbox),
                location: enrichment.location,
                country: enrichment.country,
                adminRegion: enrichment.adminRegion,
              });
              console.log("[ProjectSubmit:BG] [GIS] enrichment persisted", {
                projectId: project.id,
                areaHectares: enrichment.areaHectares,
                location: enrichment.location,
                country: enrichment.country,
              });
            } catch (gisErr) {
              console.warn("[ProjectSubmit:BG] [GIS] enrichment failed (non-blocking):", (gisErr as Error)?.message ?? gisErr);
            }

            try {
              const mrvStatusStartedAt = Date.now();
              console.log("[ProjectSubmit:BG] updateProjectMrvStatus started", { projectId: project.id });
              await withTimeout(
                storage.updateProjectMrvStatus(project.id, "IDLE"),
                PROJECT_SUBMIT_DB_TIMEOUT_MS,
                "project.updateMrvStatus"
              );
              console.log("[ProjectSubmit:BG] updateProjectMrvStatus completed", {
                projectId: project.id,
                updateMs: Date.now() - mrvStatusStartedAt,
              });
            } catch (err) {
              console.warn("[ProjectSubmit:BG] updateProjectMrvStatus failed:", err);
            }

            const t0Init = Date.now();
            try {
              console.log("[ProjectSubmit:BG] ecological initialization started", { projectId: project.id });
              const ecologicalInit = await withTimeout(
                ecologicalInitializationService.initializeProject(project),
                PROJECT_SUBMIT_INIT_TIMEOUT_MS,
                "ecologicalInitialization"
              );
              console.log("[ProjectSubmit:BG] ecological initialization completed", {
                projectId: project.id,
                initialized: ecologicalInit.initialized,
                mode: ecologicalInit.mode,
                bgMs: Date.now() - t0Init,
              });
            } catch (initError) {
              console.error("[ProjectSubmit:BG] Ecological initialization failed (non-blocking):", {
                projectId: project.id,
                error: (initError as Error)?.message ?? String(initError),
                bgMs: Date.now() - t0Init,
              });
            }

            try {
              await audit({
                userId: req.user!.id,
                actionType: AUDIT_ACTION_TYPES.PROJECT_SUBMITTED,
                entityType: "project",
                entityId: project.id,
                metadata: {
                  projectName: project.name,
                  ecosystemType: project.ecosystemType,
                  area: project.area,
                  lifetimeCO2: project.lifetimeCO2,
                  monitoringFrequency,
                  minimalMode: PROJECT_SUBMIT_MINIMAL_MODE,
                },
              });
            } catch (auditErr) {
              console.warn("[ProjectSubmit:BG] audit write failed:", auditErr);
            }
          })();
        });
      });

      res.json({
        message: "Project submitted successfully",
        project,
        carbonCalculation: {
          annualCO2,
          lifetimeCO2,
        },
      });
      console.log("[ProjectSubmit] response sent", { projectId: project.id, statusCode: 200 });
      return;
    } catch (error: any) {
      const isFkViolation =
        error?.code === "23503" ||
        (typeof error?.message === "string" &&
          (error.message.includes("foreign key constraint") ||
            error.message.includes("violates") ||
            error.message.includes("user_id")));
      const isUserNotFound =
        typeof error?.message === "string" &&
        error.message.includes("account could not be located");
      const isZodError = error?.name === "ZodError";

      let clientMessage: string;
      if (isFkViolation || isUserNotFound) {
        clientMessage =
          "Your account could not be located. Please sign in again.";
      } else if (isZodError) {
        clientMessage =
          (error.errors?.[0]?.message as string | undefined) ??
          "Invalid submission data. Please check all fields.";
      } else if (error?.message === "project.create timed out") {
        clientMessage = "Submission timed out. Please try again.";
      } else {
        clientMessage =
          "Unable to submit project. Please try again or contact support.";
      }

      console.error("[ProjectSubmit] Submission error:", {
        code: error?.code,
        constraint: error?.constraint,
        message: error?.message,
        clientMessage,
        totalMs: Date.now() - requestStartedAt,
      });
      return res.status(400).json({ error: clientMessage });
    }
  });

  app.get("/api/projects", async (req, res) => {
    try {
      const { limit, offset } = parsePaginationParams(req);
      const allProjects = await storage.getAllProjects();
      const total = allProjects.length;
      
      // Sort by submittedAt descending (newest first)
      const sorted = [...allProjects].sort((a, b) => 
        new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
      );
      
      const paginatedProjects = sorted.slice(offset, offset + limit);
      
      return res.json({
        data: paginatedProjects,
        pagination: getPaginationMeta(total, limit, offset),
      });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });

  // Get current user's projects - Protected
  app.get("/api/projects/my", requireAuth, async (req: AuthRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const projects = await storage.getProjectsByUserId(req.user.id);
      return res.json(projects);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });

  // Get pending projects - Protected (verifier only)
  app.get("/api/projects/pending", requireAuth, requireRole('verifier', 'admin'), async (req, res) => {
    try {
      const projects = await storage.getProjectsByStatus('pending');
      return res.json(projects);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });

  // Get verifier's assigned reviews - Protected (verifier/admin only)
  app.get("/api/projects/my-reviews", requireAuth, requireRole('verifier', 'admin'), async (req: AuthRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Authentication required" });
      }
      console.log("Fetching history for verifier:", req.user.id);
      const projects = await storage.getVerifiedProjectsByVerifierId(req.user.id);
      console.log("Projects found:", projects.length);
      return res.json(projects);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/projects/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const project = await storage.getProject(id);
      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }
      return res.json(project);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/projects/:id/assign", requireAuth, requireRole('verifier', 'admin'), async (req: AuthRequest, res) => {
    try {
      const { id } = req.params;
      const { verifierId } = req.body;

      const updated = await verifierWorkflowService.assignVerifier(
        id,
        verifierId,
        "system:assignment-route",
      );

      // Audit: verifier assigned to project
      await audit({
        userId: req.user?.id ?? null,
        actionType: AUDIT_ACTION_TYPES.VERIFIER_ASSIGNED,
        entityType: "project",
        entityId: id,
        metadata: { verifierId },
      });

      // Email: notify verifier of new assignment
      const project = await storage.getProject(id).catch(() => null);
      if (project) {
        storage.getUser(verifierId).then((verifier) => {
          if (verifier?.email) {
            emailService.sendVerifierAssigned({
              projectName: project.name,
              projectId: id,
              verifierEmail: verifier.email,
              verifierName: verifier.name,
              ecosystemType: project.ecosystemType,
              areaHa: project.area,
            }).catch(() => {});
          }
        }).catch(() => {});
      }
      return res.json(updated);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/projects/:id/verifier-foundation-review", requireAuth, requireRole("verifier", "admin"), async (req: AuthRequest, res) => {
    try {
      const { id } = req.params;
      if (!req.user) return res.status(401).json({ error: "Authentication required" });
      const project = await storage.getProject(id);
      if (!project) return res.status(404).json({ error: "Project not found" });
      const persisted = await verifierWorkflowService.submitEnhancedReview(id, req.user.id, req.body);
      return res.json({ success: true, ...persisted });
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/projects/:id/review", requireAuth, requireRole("verifier", "admin"), async (req: AuthRequest, res) => {
    try {
      const { id } = req.params;
      const { action, rejectionReason, comment, clarificationNote } = projectReviewSchema.parse({
        projectId: id,
        ...req.body,
      });

      // Day 4: Check if verification is enabled before approving
      if (action === "approve") {
        const mintingEnabled = true;
        if (!mintingEnabled) {
          return res.status(403).json({
            error: "Verification temporarily disabled by admin. Approval not allowed at this time.",
            mintingEnabled: false
          });
        }
      }

      const project = await storage.getProject(id);
      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }

      // ── Verifier Conflict of Interest Check ──────────────────────────────
      if (req.user?.id === project.userId && req.user?.role !== "admin") {
        console.warn(
          `COI attempt: User ${req.user.id} tried to verify their own project ${id}`
        );
        return res.status(403).json({
          error: "Conflict of Interest: Verifiers cannot verify their own projects.",
        });
      }

      // ── Task 2.3: Project Freeze — block reviews on already-verified projects ──
      if (project.status === "verified") {
        return res.status(400).json({
          error: "Cannot review a project that is already verified. Revoke verification first.",
        });
      }

      // ── Reject action ─────────────────────────────────────────────────────
      if (action === "reject") {
        if (!rejectionReason) {
          return res.status(400).json({
            error: "A rejection reason code is required when rejecting a project.",
          });
        }
        await storage.updateProject(id, {
          status: "rejected",
          rejectionReason: rejectionReason + (comment ? `: ${comment}` : ""),
          clarificationNote: null,
          verifierId: req.user?.id,
        });
        // Audit: project rejected
        await audit({
          userId: req.user?.id,
          actionType: AUDIT_ACTION_TYPES.PROJECT_REJECTED,
          entityType: "project",
          entityId: id,
          metadata: {
            projectName: project.name,
            contributorId: project.userId,
            rejectionReason,
            comment: comment ?? null,
          },
        });
        // Email: notify contributor of rejection (fire-and-forget)
        storage.getUser(project.userId).then((contributor) => {
          if (contributor?.email) {
            emailService.sendProjectRejected({
              projectName: project.name,
              projectId: id,
              contributorName: contributor.name,
              contributorEmail: contributor.email,
              reason: rejectionReason + (comment ? `: ${comment}` : ""),
            }).catch(() => {});
          }
        }).catch(() => {});
        return res.json({ success: true, message: "Project rejected" });
      }

      // ── Task 2.1: Clarify action — uses dedicated needs_clarification status ──
      if (action === "clarify") {
        if (!clarificationNote) {
          return res.status(400).json({
            error: "A clarification note is required when requesting clarification.",
          });
        }
        await storage.updateProject(id, {
          status: "needs_clarification",
          clarificationNote,
          rejectionReason: null,
          verifierId: req.user?.id,
        });
        // Audit: clarification requested
        await audit({
          userId: req.user?.id,
          actionType: AUDIT_ACTION_TYPES.PROJECT_CLARIFICATION_REQUESTED,
          entityType: "project",
          entityId: id,
          metadata: {
            projectName: project.name,
            contributorId: project.userId,
            clarificationNote,
          },
        });
        // Email: notify contributor clarification is needed
        storage.getUser(project.userId).then((contributor) => {
          if (contributor?.email) {
            emailService.sendProjectClarification({
              projectName: project.name,
              projectId: id,
              contributorName: contributor.name,
              contributorEmail: contributor.email,
              reason: clarificationNote,
            }).catch(() => {});
          }
        }).catch(() => {});
        return res.json({
          success: true,
          message: "Clarification requested. The contributor has been notified.",
        });
      }

      // ── Task 2.3: Only allow approval if project is in a reviewable state ──
      if (project.status !== "pending" && project.status !== "needs_clarification") {
        return res.status(400).json({
          error: `Cannot approve a project with status '${project.status}'.`,
        });
      }

      await storage.updateProject(id, {
        status: "verified",
        creditsEarned: project.lifetimeCO2,
        verifierId: req.user?.id,
      });

      // Invalidate stats cache so verifiers see the newly verified project
      cache.invalidate("stats:global");

      // Audit: project approved
      await audit({
        userId: req.user?.id,
        actionType: AUDIT_ACTION_TYPES.PROJECT_APPROVED,
        entityType: "project",
        entityId: id,
        metadata: {
          projectName: project.name,
          contributorId: project.userId,
          creditsIssued: project.lifetimeCO2,
        },
      });

      // Email: notify contributor of approval
      storage.getUser(project.userId).then((contributor) => {
        if (contributor?.email) {
          emailService.sendProjectApproved({
            projectName: project.name,
            projectId: id,
            contributorName: contributor.name,
            contributorEmail: contributor.email,
            ecosystemType: project.ecosystemType,
            areaHa: project.area,
          }).catch(() => {});
        }
      }).catch(() => {});
      return res.json({ success: true, message: "Project verified successfully" });
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  });

  // GET /api/projects/:id/environmental-summary — synthesised intelligence summary
  app.get("/api/projects/:id/environmental-summary", requireAuth, requireRole("verifier", "admin"), asyncHandler(async (req: any, res: any) => {
    const { id } = req.params;
    const project = await storage.getProject(id);
    if (!project) return res.status(404).json({ error: "Project not found" });

    // Pull latest evidence run metrics if available
    let metrics: any = null;
    let runCount = 0;
    try {
      const runIds = await evidenceService.listRunIds(id);
      runCount = runIds.length;
      if (runIds.length > 0) {
        metrics = await evidenceService.getMetrics(id, runIds[0]!);
      }
    } catch {
      // evidence may not exist yet — return summary without metrics
    }

    const ndvi = metrics?.vegetation?.ndvi_mean ?? null;
    const risk = metrics?.risk?.overall_risk_score ?? null;
    const trend = metrics?.historical?.ndvi_trend ?? null;

    return res.json({
      projectId: id,
      registryId: (project as any).registryId ?? null,
      location: (project as any).location ?? null,
      ecosystemType: (project as any).ecosystemType ?? null,
      baselineVsCurrent: metrics ? { ndvi, risk } : null,
      trend: trend !== null ? { ndvi_trend: trend } : null,
      monitoringTimelineCount: runCount,
      status: (project as any).status ?? "unknown",
      ecosystemHealthIndex: ndvi !== null ? Math.round(ndvi * 100) : null,
      ecosystemTrajectory: trend === null ? null : trend > 0.005 ? "improving" : trend < -0.005 ? "declining" : "stable",
      qualityScore: metrics?.validation ?? null,
      multiCycleTrends: null,
    });
  }));

  // ── Public Transparency API — no auth required ─────────────────────────────
  // GET /api/public/projects/:id — read-only project summary for transparency page
  app.get("/api/public/projects/:id", asyncHandler(async (req: any, res: any) => {
    const { id } = req.params;
    const project = await storage.getProject(id);
    if (!project || project.status !== "verified") {
      return res.status(404).json({ error: "Verified project not found" });
    }

    // Latest evidence metrics (read-only, no sensitive data)
    let metrics: any = null;
    let latestRunId: string | null = null;
    try {
      const runs = await storage.getAnalysisRunsByProject(id);
      const latestRun = runs
        .filter((r) => r.status === "complete")
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
      if (latestRun) {
        latestRunId = latestRun.runId;
        const rawMetrics = await evidenceService.getMetrics(id, latestRun.runId);
        if (rawMetrics) {
          metrics = {
            ndvi_mean: rawMetrics.vegetation?.ndvi_mean,
            ecosystem_health_index: rawMetrics.trust?.ecosystem_health_index,
            risk_score: rawMetrics.risk?.overall_risk_score,
            restoration_suitability: rawMetrics.restoration?.suitability_score,
            trend_direction: rawMetrics.historical?.trend_direction,
            monitoring_date: rawMetrics.monitoring?.end_date ?? rawMetrics.generated_at,
            satellite_source: rawMetrics.monitoring?.satellite_source,
          };
        }
      }
    } catch (_) {}

    return res.json({
      id: project.id,
      name: project.name,
      description: project.description,
      location: project.location,
      ecosystemType: project.ecosystemType,
      areaHa: project.area,
      status: project.status,
      verifiedAt: (project as any).verifiedAt ?? null,
      annualCO2: project.annualCO2,
      lifetimeCO2: project.lifetimeCO2,
      registryId: (project as any).registryId ?? null,
      latestRunId,
      metrics,
    });
  }));

  app.get("/api/projects/:id/certificate", async (req, res) => {
    try {
      const { id } = req.params;
      const project = await storage.getProject(id);

      if (!project || project.status !== 'verified') {
        return res.status(404).json({ error: "Verified project not found" });
      }

      const certificate = {
        projectName: project.name,
        projectDescription: project.description,
        co2Captured: project.co2Captured,
        status: project.status,
        submittedAt: project.submittedAt,
        issuedAt: new Date().toISOString(),
        certificateId: `BC-${project.id}`,
      };

      // Audit: certificate issued (accessed)
      // Note: this endpoint is public — userId may be null for unauthenticated access
      await audit({
        userId: null,
        actionType: AUDIT_ACTION_TYPES.CERTIFICATE_ISSUED,
        entityType: "project",
        entityId: id,
        metadata: {
          certificateId: certificate.certificateId,
          projectName: project.name,
          co2Captured: project.co2Captured,
        },
      });

      return res.json(certificate);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });



  // ─── PAGINATION HELPERS ───────────────────────────────────────────────────────
  const DEFAULT_LIMIT = 20;
  const MAX_LIMIT = 100;

  function parsePaginationParams(req: any) {
    const limit = Math.min(
      parseInt(req.query.limit) || DEFAULT_LIMIT,
      MAX_LIMIT
    );
    const offset = parseInt(req.query.offset) || 0;
    return { limit, offset };
  }

  function getPaginationMeta(total: number, limit: number, offset: number) {
    return {
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
    };
  }



  // VERIFIER DASHBOARD STATUS (Improved Performance & Stats)
  app.get("/api/verifier/status", requireAuth, requireRole('verifier', 'admin'), async (req: AuthRequest, res) => {
    try {
      const mintingEnabled = true;

      // Get verified and rejected projects by this verifier
      const myReviews = await storage.getVerifiedProjectsByVerifierId(req.user!.id);
      // Enhanced performance aggregation
      const verifiedProjects = myReviews.filter(p => p.status === 'verified');
      const rejectedProjects = myReviews.filter(p => p.status === 'rejected');

      const totalCO2 = verifiedProjects.reduce((sum, p) => sum + (p.co2Captured || 0), 0);

      // Average review time calculation - using submittedAt as a base
      let avgReviewDays = 0;
      if (myReviews.length > 0) {
        const totalMs = myReviews.reduce((sum, p) => {
          const start = new Date(p.submittedAt).getTime();
          const end = Date.now(); // Fallback estimate since project is finalized
          return sum + (end - start);
        }, 0);
        avgReviewDays = totalMs / myReviews.length / (1000 * 60 * 60 * 24);
      }

      // Trust Score: verified projects / (verified + rejected) or 100%
      const totalReviews = verifiedProjects.length + rejectedProjects.length;
      const trustScore = totalReviews > 0
        ? Math.round((verifiedProjects.length / totalReviews) * 100)
        : 100;

      const warnings = await storage.getWarningsByContributorId(req.user!.id);

      return res.json({
        mintingEnabled,
        trustScore,
        warningCount: warnings.length,
        performance: {
          verified: verifiedProjects.length,
          rejected: rejectedProjects.length,
          totalCO2: Math.round(totalCO2 * 100) / 100,
          avgReviewTime: Math.max(0.1, Math.round(avgReviewDays * 10) / 10) || 0,
          pendingReviews: (await storage.getProjectsByStatus('pending')).length
        },
        meta: {
          verifierId: req.user!.id,
          totalInteractions: myReviews.length,
          timestamp: new Date().toISOString()
        }
      });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });

  // Verifier list is only needed for project assignment (verifier/admin).
  app.get("/api/users/verifiers", requireAuth, requireRole("verifier", "admin"), async (_req, res) => {
    try {
      const verifiers = await storage.getUsersByRole('verifier');
      return res.json(verifiers.map(v => ({ ...v, password: undefined })));
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });



  // OBJECT STORAGE ROUTES
  app.post("/api/objects/upload", requireAuth, async (req, res) => {
    try {
      const objectStorageService = new ObjectStorageService();
      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      res.json({ uploadURL });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/proof-files", requireAuth, async (req, res) => {
    try {
      if (!req.body.proofFileURL) {
        return res.status(400).json({ error: "proofFileURL is required" });
      }

      const objectStorageService = new ObjectStorageService();
      const objectPath = await objectStorageService.trySetObjectEntityAclPolicy(
        req.body.proofFileURL,
        {
          owner: 'system',
          visibility: "public",
        },
      );

      res.status(200).json({ objectPath });
    } catch (error: any) {
      console.error("Error setting proof file:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/objects/:objectPath(*)", async (req, res) => {
    const objectStorageService = new ObjectStorageService();
    try {
      const objectFile = await objectStorageService.getObjectEntityFile(req.path);
      objectStorageService.downloadObject(objectFile, res);
    } catch (error) {
      console.error("Error accessing object:", error);
      if (error instanceof ObjectNotFoundError) {
        return res.sendStatus(404);
      }
      return res.sendStatus(500);
    }
  });

  // ─── DATABASE BACKUP ENDPOINT (Task 4.3) ─────────────────────────────────────
  // Admin-only endpoint to trigger a manual backup export (JSON dump of all tables).
  // This provides a downloadable snapshot of the database state for disaster recovery.
  app.post("/api/admin/backup", requireAuth, requireRole('admin'), async (req: AuthRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      // Collect all data from storage
      const [
        allUsers,
        allProjects,
      ] = await Promise.all([
        storage.getAllUsers(),
        storage.getAllProjects(),
      ]);

      // Remove sensitive data (passwords) from users
      const sanitizedUsers = allUsers.map((user) => {
        const { password: _password, ...userWithoutPassword } = user;
        return userWithoutPassword;
      });

      // Get audit logs from in-memory store
      const auditLogsData = await (async () => {
        try {
          const { memAuditLog } = await import("./auditLog");
          return memAuditLog.getAll();
        } catch {
          return [];
        }
      })();

      // Build backup object with metadata
      const backup = {
        metadata: {
          exportedAt: new Date().toISOString(),
          exportedBy: req.user.id,
          version: "1.0",
          environment: process.env.NODE_ENV || "development",
        },
        counts: {
          users: sanitizedUsers.length,
          projects: allProjects.length,
          auditLogs: auditLogsData.length,
        },
        data: {
          users: sanitizedUsers,
          projects: allProjects,
          auditLogs: auditLogsData,
        },
      };

      // Set headers for file download
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `bluecarbon-backup-${timestamp}.json`;

      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

      // Audit: backup was triggered
      await audit({
        userId: req.user.id,
        actionType: "BACKUP_CREATED" as any,
        entityType: "system",
        entityId: null,
        metadata: {
          filename,
          recordCounts: backup.counts,
        },
      });

      return res.json(backup);
    } catch (error: any) {
      console.error("Backup failed:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  // ─── ADMIN GOVERNANCE & LEDGER ROUTES (New Upgrade) ───────────────────────────

  app.get("/api/admin/top-contributors", requireAuth, requireRole('admin'), async (_req, res) => {
    try {
      const topContributors = await storage.getTopContributors();
      return res.json(topContributors);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });

  // POST /api/admin/projects/:id/remove - Add UUID validation
  app.post("/api/admin/projects/:id/remove", requireAuth, requireRole('admin'), async (req: AuthRequest, res) => {
    try {
      const { id } = req.params;

      // Validate UUID format for security
      if (!isValidUUID(id)) {
        return res.status(400).json({ error: "Invalid Project ID format" });
      }

      const project = await storage.getProject(id);
      if (!project) return res.status(404).json({ error: "Project not found" });

      await storage.updateProject(id, { isListed: false });

      await audit({
        userId: req.user!.id,
        actionType: "PROJECT_REMOVED_FROM_EXPLORER" as any,
        entityType: "project",
        entityId: id,
        metadata: { projectName: project.name },
      });

      return res.json({ success: true, message: "Project removed from explorer" });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });

  // POST /api/admin/warnings - Add strict severity validation
  app.post("/api/admin/warnings", requireAuth, requireRole('admin'), async (req: AuthRequest, res) => {
    try {
      const { contributorId, message, severity } = req.body;
      if (!contributorId || !message || !severity) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      // Strict severity validation - only allow low, medium, critical
      const allowedSeverity = ["low", "medium", "critical"];
      if (!allowedSeverity.includes(severity.toLowerCase())) {
        return res.status(400).json({ error: "Invalid severity. Allowed values: low, medium, critical" });
      }

      const warning = await storage.issueWarning({ contributorId, message, severity: severity.toLowerCase() });

      await audit({
        userId: req.user!.id,
        actionType: "WARNING_ISSUED" as any,
        entityType: "user",
        entityId: contributorId,
        metadata: { message, severity },
      });

      return res.json(warning);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/admin/warnings/:contributorId", requireAuth, async (req: AuthRequest, res) => {
    try {
      const { contributorId } = req.params;
      // Admin can see any, contributors can only see their own
      if (req.user!.role !== 'admin' && req.user!.id !== contributorId) {
        return res.status(403).json({ error: "Access denied" });
      }
      const warnings = await storage.getWarningsByContributorId(contributorId);
      return res.json(warnings);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });



  // ─── MRV SYSTEM ROUTES (Queue-backed orchestration) ─────────────────────────

  app.post("/api/mrv/trigger", requireAuth, requireRole("verifier", "admin"), async (req: AuthRequest, res) => {
    try {
      console.log(`[MRV Trigger] Received for project ${req.body.projectId}`);

      const { projectId } = req.body;

      if (!projectId) {
        return res.status(400).json({ error: "Missing projectId in request body" });
      }

      const project = await storage.getProject(projectId);
      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }

      if (!project.landBoundary) {
        return res.status(400).json({ error: "Project has no valid GIS boundary to analyze" });
      }

      // Deduplication guard: reject if an analysis is already in flight
      const currentStatus = (project.mrvStatus ?? "").toUpperCase();
      if (currentStatus === "RUNNING") {
        const snapshot = await monitoringOrchestratorService.getStatus(projectId);
        console.warn(`[MRV Trigger] Duplicate trigger rejected for ${projectId} — already at ${snapshot.progress}% (${snapshot.step})`);
        return res.status(409).json({
          error: "Analysis already in progress",
          status: "RUNNING",
          progress: snapshot.progress,
          step: snapshot.step,
        });
      }

      const queued = project.baselineCompletedAt
        ? await monitoringOrchestratorService.triggerScheduledMonitoring({
            projectId,
            landBoundary: project.landBoundary,
            triggeredBy: `user:${req.user?.id ?? "unknown"}`,
          })
        : await monitoringOrchestratorService.triggerBaselineAnalysis({
            projectId,
            landBoundary: project.landBoundary,
            triggeredBy: `user:${req.user?.id ?? "unknown"}`,
          });

      return res.json({ status: "started", jobId: queued.jobId, queueMode: queued.queueMode });

    } catch (err: any) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/mrv/cancel", requireAuth, requireRole("verifier", "admin"), async (req: AuthRequest, res) => {
    try {
      const { projectId } = req.body;
      if (!projectId) return res.status(400).json({ error: "Missing projectId" });
      await monitoringOrchestratorService.cancel(projectId);
      console.log(`[MRV] Cancel requested for ${projectId}`);
      return res.json({ status: 'CANCELLED' });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/mrv/:projectId", async (req, res) => {
    try {
      const { projectId } = req.params;
      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ error: "Not found" });

      const score = await storage.getMrvScore(projectId);
      const measurements = await storage.getNdviMeasurements(projectId);
      const latestNdvi = measurements.length > 0 ? measurements[measurements.length - 1] : null;

      const runtimeStatus = await monitoringOrchestratorService.getStatus(projectId);
      console.log(`[MRV Poll] ${projectId}: mrvStatus=${runtimeStatus.status} progress=${runtimeStatus.progress}%`);

      // Extract tile URL from stored rawGeeResponse
      let ndviTileUrl: string | null = null;
      if (latestNdvi?.rawGeeResponse) {
        try {
          const raw = JSON.parse(latestNdvi.rawGeeResponse);
          ndviTileUrl = raw?.current?.tileUrl ?? null;
        } catch (_) {}
      }

      return res.json({
        status: runtimeStatus.status,
        progress: runtimeStatus.progress,
        step: runtimeStatus.step,
        data: score || null,
        measurements,
        ndvi: latestNdvi?.ndviMean ?? null,
        baselineNdvi: score?.baselineNdvi ?? null,
        ndviTileUrl,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ─── Rate limiters for heavy intelligence/report endpoints ─────────────────
  const intelligenceLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Intelligence query rate limit exceeded. Try again shortly." },
    skip: () => process.env.NODE_ENV === "test",
  });

  const reportLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Report generation rate limit exceeded. Please wait before generating another report." },
    skip: () => process.env.NODE_ENV === "test",
  });

  // ─── Verifier Intelligence + Reporting APIs (cache-enabled) ─────────────────

  // [PROD-1 Cleaned Obsolete Intelligence/Calibration Endpoints]



  app.get("/api/mrv/report/:projectId", async (req, res) => {
    try {
      const { projectId } = req.params;
      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ error: "Not found" });

      const score = await storage.getMrvScore(projectId);
      const measurements = await storage.getNdviMeasurements(projectId);
      const latestNdvi = measurements.length > 0 ? measurements[measurements.length - 1] : null;

      // Dynamic import to avoid esbuild issues with browser-focused packages
      const { jsPDF } = await import("jspdf");
      const doc = new jsPDF();
      
      doc.setFontSize(22);
      doc.text("NEVARA MRV Report", 20, 20);
      
      doc.setFontSize(12);
      doc.text(`Project Name: ${project.name}`, 20, 40);
      doc.text(`Project ID: ${project.id}`, 20, 50);
      doc.text(`Location: ${project.location}`, 20, 60);
      doc.text(`Ecosystem: ${project.ecosystemType}`, 20, 70);
      doc.text(`Area: ${project.area} hectares`, 20, 80);
      
      doc.setFontSize(16);
      doc.text("Vegetation Analysis (NDVI)", 20, 100);
      doc.setFontSize(12);
      doc.text(`Current NDVI: ${latestNdvi?.ndviMean?.toFixed(4) || 'N/A'}`, 20, 110);
      doc.text(`Baseline NDVI: ${score?.baselineNdvi?.toFixed(4) || 'N/A'}`, 20, 120);
      
      if (score) {
        doc.text(`Variance (Delta %): ${score.ndviDeltaPct?.toFixed(2)}%`, 20, 130);
        doc.setFontSize(16);
        doc.text("Ecosystem Trust Score", 20, 150);
        doc.setFontSize(14);
        doc.text(`Score: ${score.trustScore} / 100`, 20, 160);
        doc.text(`Confidence Level: ${score.confidence}`, 20, 170);
      }

      doc.setFontSize(10);
      doc.text(`Generated on: ${new Date().toISOString()}`, 20, 280);

      const pdfBuffer = Buffer.from(doc.output('arraybuffer'));

      console.log(`[MRV] [REPORT] [Report Generated] Successfully generated PDF report for project ${projectId}`);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=mrv_report_${projectId}.pdf`);
      return res.send(pdfBuffer);
    } catch (err: any) {
      console.error("[MRV] [REPORT] PDF generation error:", err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/mrv/webhook", async (req, res) => {
    try {
      const { projectId, score } = req.body;
      console.log("[MRV Webhook] received for project", projectId);

      // Guard: do not overwrite a user-cancelled job
      const existing = await storage.getProject(projectId);
      if (existing?.mrvStatus?.toUpperCase() === 'CANCELLED') {
        console.log(`[MRV Webhook] Ignoring — project ${projectId} was cancelled.`);
        return res.json({ success: true, ignored: true });
      }

      await storage.updateProjectMrvStatus(projectId, 'COMPLETED');

      if (score) {
        await storage.createMrvScore({
          projectId,
          trustScore: score.trust_score || score.trustScore || 85,
          confidence: score.confidence || 'HIGH',
          baselineNdvi: score.baseline_ndvi || score.baselineNdvi || 0.4,
          currentNdvi: score.current_ndvi || score.currentNdvi || 0.6,
          ndviDeltaPct: score.ndvi_delta_pct || score.ndviDeltaPct || 15.0,
          canopyPct: score.canopy_pct || score.canopyPct || 60.0,
          ecosystemFactor: score.ecosystem_factor || score.ecosystemFactor || 0.8,
          areaHa: score.area_ha || score.areaHa || 10,
        });
      }

      const updated = await storage.getProject(projectId);
      console.log(`[MRV Webhook] Project ${projectId} updated — mrvStatus: ${updated?.mrvStatus}`);

      // Email: notify contributor that monitoring cycle completed
      if (updated) {
        storage.getUser(updated.userId).then(async (contributor) => {
          if (!contributor?.email) return;
          // Try to load metrics for KPI summary in email
          let metricsKpi: { ecosystemHealthScore?: number; ndviMean?: number; riskScore?: number } = {};
          try {
            const runs = await storage.getAnalysisRunsByProject(projectId);
            const latestRun = runs.sort((a, b) =>
              new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
            )[0];
            if (latestRun) {
              const metrics = await evidenceService.getMetrics(projectId, latestRun.runId);
              if (metrics) {
                metricsKpi = {
                  ecosystemHealthScore: metrics.trust?.ecosystem_health_index ?? undefined,
                  ndviMean: metrics.vegetation?.ndvi_mean ?? undefined,
                  riskScore: metrics.risk?.overall_risk_score ?? undefined,
                };
              }
            }
          } catch (_) {}
          emailService.sendMrvCompleted({
            projectName: updated.name,
            projectId,
            runId: "",
            contributorEmail: contributor.email,
            contributorName: contributor.name,
            ...metricsKpi,
          }).catch(() => {});
        }).catch(() => {});
      }
      return res.json({ success: true });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ─── Health / Liveness endpoints ─────────────────────────────────────────
  // GET /api/health — fast liveness probe (no DB, suitable for load balancer)
  app.get("/api/health", (_req, res) => {
    res.json(getLivenessResult());
  });

  // GET /api/health/full — readiness probe (checks DB, GEE, queue)
  app.get("/api/health/full", async (_req, res) => {
    try {
      const result = await getFullHealthResult();
      const httpStatus = result.status === "unhealthy" ? 503 : 200;
      res.status(httpStatus).json(result);
    } catch (err: any) {
      res.status(500).json({ status: "error", error: err.message });
    }
  });

  // ─── Admin Operational Panel APIs ─────────────────────────────────────────
  // GET /api/ops/status — full operational status snapshot (admin only)
  app.get("/api/ops/status", requireAuth, requireRole("admin"), async (_req, res) => {
    try {
      const status = await getOpsStatus();
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/ops/audit-events — query audit event buffer (admin only)
  app.get("/api/ops/audit-events", requireAuth, requireRole("admin"), (req, res) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? "100")), 500);
    const category = req.query.category as any;
    const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
    const since = req.query.since ? new Date(String(req.query.since)) : undefined;
    const events = getRecentEvents(limit, { category, projectId, since });
    res.json({ events, stats: getEventStats() });
  });



  // ─── Performance Summary ──────────────────────────────────────────────────
  // GET /api/ops/performance — per-route latency histogram (admin)
  app.get("/api/ops/performance", requireAuth, requireRole("admin"), (_req, res) => {
    return res.json({ summary: getPerformanceSummary(), ts: new Date().toISOString() });
  });

  // ─── Asset Cleanup ─────────────────────────────────────────────────────
  // POST /api/ops/cleanup — trigger asset retention cleanup (admin)
  // ?dryRun=false to actually delete (default: dry-run)
  app.post("/api/ops/cleanup", requireAuth, requireRole("admin"), async (req, res) => {
    const dryRun = req.query.dryRun !== "false";
    const results = await runAssetCleanup({ dryRun });
    appendAuditEvent({
      category: "SYSTEM",
      severity: "INFO",
      action: dryRun ? "retention.dryRun.api" : "retention.cleanup.api",
      detail: `Cleanup triggered via API. dryRun=${dryRun}`,
    });
    return res.json({ results, dryRun });
  });

  // ─── SSE Real-time Streaming ───────────────────────────────────────
  // GET /api/sse/mrv-progress?projectId=<id> — project MRV progress stream (verifier/admin)
  app.get("/api/sse/mrv-progress", requireAuth, requireRole("verifier", "admin"), (req, res) => {
    const projectId = req.query.projectId ? String(req.query.projectId) : null;
    if (!projectId) {
      return res.status(400).json({ error: "projectId query parameter required" });
    }
    registerProjectSubscriber(projectId, res);
    appendAuditEvent({
      category: "SYSTEM",
      severity: "INFO",
      action: "sse.subscribed",
      detail: `Verifier SSE subscription started for project ${projectId}`,
      projectId,
    });
  });

  // GET /api/sse/audit — admin audit event stream
  app.get("/api/sse/audit", requireAuth, requireRole("admin"), (req, res) => {
    registerAdminSubscriber(res);
    // Forward future audit events to this SSE stream
    const forwarder = (event: any) => pushAuditEvent(event);
    auditEventEmitter.on("event", forwarder);
    res.on("close", () => {
      auditEventEmitter.off("event", forwarder);
    });
  });

  // ── Evidence Package Endpoints (Phase 1, read-only) ────────────────────────

  // resolveRun — finds a run from DB/memory first, then synthesises from on-disk manifest.
  // Prevents 404s when analysis_runs DB records are missing but evidence files exist.
  async function resolveRun(projectId: string, runId: string) {
    const dbRun = await storage.getAnalysisRun(runId);
    if (dbRun && dbRun.projectId === projectId) return dbRun;
    // Filesystem fallback: synthesise from manifest when DB record is absent
    const manifest = await evidenceService.getManifest(projectId, runId);
    if (!manifest) {
      console.warn(`[resolveRun] no DB record and no manifest for run=${runId} project=${projectId}`);
      return null;
    }
    console.debug(`[resolveRun] DB miss — synthesised run from manifest run=${runId}`);
    const createdAt = manifest.created_at ? new Date(manifest.created_at) : new Date();
    return {
      id: runId,
      runId,
      projectId,
      status: (manifest.status ?? "complete") as any,
      startedAt: createdAt,
      completedAt: manifest.status === "complete" ? createdAt : null,
      evidencePath: evidenceService.getEvidencePath(projectId, runId),
      createdAt,
    };
  }

  // GET /api/evidence/:projectId — list all run metadata for a project
  app.get("/api/evidence/:projectId", requireAuth, requireRole("verifier", "admin"), asyncHandler(async (req: any, res: any) => {
    const { projectId } = req.params;
    const dbRuns = await storage.getAnalysisRunsByProject(projectId);
    const runIds = await evidenceService.listRunIds(projectId);

    // Merge: use DB records where available; synthesise from FS for any DB-missing runs
    const dbRunIds = new Set(dbRuns.map((r) => r.runId));
    const fsOnlyIds = runIds.filter((id) => !dbRunIds.has(id));
    const fsRuns = (await Promise.all(
      fsOnlyIds.map(async (runId) => {
        const manifest = await evidenceService.getManifest(projectId, runId);
        if (!manifest) return null;
        const createdAt = manifest.created_at ?? new Date().toISOString();
        return {
          runId,
          status: manifest.status ?? "complete",
          startedAt: createdAt,
          completedAt: manifest.status === "complete" ? createdAt : null,
          evidencePath: evidenceService.getEvidencePath(projectId, runId),
        };
      }),
    )).filter(Boolean);

    const allRuns = [
      ...dbRuns.map((r) => ({
        runId: r.runId,
        status: r.status,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        evidencePath: r.evidencePath,
      })),
      ...fsRuns,
    ].sort((a, b) => {
      const ta = new Date((a as any).startedAt).getTime();
      const tb = new Date((b as any).startedAt).getTime();
      return tb - ta;
    });

    return res.json({
      projectId,
      runCount: allRuns.length,
      runs: allRuns,
      fsRunIds: runIds,
    });
  }));

  // GET /api/evidence/:projectId/:runId/validation — validation summary + inventories
  app.get("/api/evidence/:projectId/:runId/validation", requireAuth, requireRole("verifier", "admin"), asyncHandler(async (req: any, res: any) => {
    const { projectId, runId } = req.params;
    const run = await resolveRun(projectId, runId);
    if (!run) {
      return res.status(404).json({ error: "Evidence run not found" });
    }

    const report = await evidenceService.validateRun(projectId, runId);
    return res.json({
      runId,
      projectId,
      ...report,
    });
  }));

  // GET /api/evidence/:projectId/:runId/summary — evidence viewer metadata
  app.get("/api/evidence/:projectId/:runId/summary", requireAuth, requireRole("verifier", "admin"), asyncHandler(async (req: any, res: any) => {
    const { projectId, runId } = req.params;
    const run = await resolveRun(projectId, runId);
    if (!run) {
      return res.status(404).json({ error: "Evidence run not found" });
    }

    const summary = await evidenceService.getSummary(projectId, runId);
    return res.json(summary);
  }));

  // GET /api/evidence/:projectId/:runId — manifest + metrics summary for a specific run
  app.get("/api/evidence/:projectId/:runId", requireAuth, requireRole("verifier", "admin"), asyncHandler(async (req: any, res: any) => {
    const { projectId, runId } = req.params;
    const run = await resolveRun(projectId, runId);
    if (!run) {
      return res.status(404).json({ error: "Evidence run not found" });
    }
    const manifest = await evidenceService.getManifest(projectId, runId);
    const metrics = await evidenceService.getMetrics(projectId, runId);
    const evidenceDir = evidenceService.getEvidencePath(projectId, runId);
    const { readJsonFile } = await import("./evidence/evidenceStorage");
    const observations = await readJsonFile(evidenceDir, "observations.json");
    return res.json({
      run: {
        runId: run.runId,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        evidencePath: run.evidencePath,
      },
      manifest,
      metrics,
      observations,
    });
  }));

  // GET /api/evidence/:projectId/:runId/asset/:filename — serve evidence PNG asset
  app.get("/api/evidence/:projectId/:runId/asset/:filename", requireAuth, requireRole("verifier", "admin"), asyncHandler(async (req: any, res: any) => {
    const { projectId, runId, filename } = req.params;
    if (!String(filename).endsWith(".png") || String(filename).includes("/") || String(filename).includes("\\")) {
      return res.status(400).json({ error: "Invalid asset filename" });
    }
    const run = await resolveRun(projectId, runId);
    if (!run) {
      return res.status(404).json({ error: "Evidence run not found" });
    }
    const manifest = await evidenceService.getManifest(projectId, runId);
    const evidenceDir = evidenceService.getEvidencePath(projectId, runId);
    const fs = await import("fs");
    const path = await import("path");
    const candidates = [
      manifest?.asset_exports?.find((asset) => asset.filename === filename)?.localPath,
      path.join(evidenceDir, "assets", filename),
      manifest?.assets?.find((asset) => asset.filename === filename)?.path,
      path.join(evidenceDir, filename),
    ].filter(Boolean) as string[];
    const resolvedBase = path.resolve(evidenceDir);
    const assetPath = candidates.find((candidate) => {
      const resolved = path.resolve(candidate);
      return resolved.startsWith(resolvedBase) && fs.existsSync(resolved);
    });
    if (!assetPath) {
      console.warn(`[evidence-asset] missing ${filename} run=${runId} candidates=[${candidates.join(", ")}]`);
      return res.status(404).json({ error: "Evidence asset not found" });
    }
    console.debug(`[evidence-asset] serving ${filename} from ${assetPath} run=${runId}`);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=3600, immutable");
    return fs.createReadStream(assetPath).pipe(res);
  }));

  // GET /api/evidence/:projectId/:runId/assets — image asset metadata for a specific run
  app.get("/api/evidence/:projectId/:runId/assets", requireAuth, requireRole("verifier", "admin"), asyncHandler(async (req: any, res: any) => {
    const { projectId, runId } = req.params;
    const run = await resolveRun(projectId, runId);
    if (!run) {
      return res.status(404).json({ error: "Evidence run not found" });
    }
    const manifest = await evidenceService.getManifest(projectId, runId);
    if (!manifest) {
      return res.status(404).json({ error: "Evidence manifest not found for this run" });
    }
    const assetPipeline = await evidenceExportService.materializeAssets({
      projectId,
      runId,
      attemptRemoteExports: req.query.refresh === "true",
      retries: 1,
    });
    const refreshedManifest = await evidenceService.getManifest(projectId, runId);
    const imageAssets = Array.from(
      new Map(
        (refreshedManifest ?? manifest).assets
          .filter((a) => a.filename.endsWith(".png"))
          .map((asset) => [asset.filename, asset]),
      ).values(),
    );
    return res.json({
      runId,
      projectId,
      imageCount: imageAssets.length,
      images: imageAssets.map((a) => ({
        filename: a.filename,
        size_bytes: a.size_bytes,
        checksum_sha256: a.checksum_sha256,
        generated_at: a.generated_at,
        source: (a as any).source ?? "procedural",
        dataset: (a as any).dataset ?? null,
        acquisition_date: (a as any).acquisition_date ?? null,
      })),
      assetDirectory: assetPipeline.assetsDir,
      requiredAssets: assetPipeline.requiredAssets,
      optionalAssets: assetPipeline.optionalAssets,
      assets: assetPipeline.assets.map((asset) => ({
        filename: asset.filename,
        type: asset.assetType,
        source: asset.assetSource,
        status: asset.status,
        generated_at: asset.generatedAt,
        gee_dataset: asset.geeDataset,
        export_method: asset.exportMethod,
        generation_duration_ms: asset.generationDurationMs,
        local_path: asset.localPath,
        source_path: asset.sourcePath,
      })),
      exportMetadata: refreshedManifest?.export_assets ?? manifest.export_assets ?? [],
    });
  }));

  // ── Evidence Report Builder Endpoints (Phase 4A, DOCX draft only) ─────────



  // ─── Portfolio Routes (CLIENT-01) ────────────────────────────────────────────

  async function getPortfolioProjects(req: AuthRequest) {
    const user = req.user!;
    if (user.role === 'contributor') {
      return storage.getProjectsByUserId(user.id);
    }
    return storage.getAllProjects();
  }

  // GET /api/portfolio/overview
  app.get("/api/portfolio/overview", requireAuth, asyncHandler(async (req: AuthRequest, res: any) => {
    const projects = await getPortfolioProjects(req);
    const active = projects.filter((p: Project) => !(p as any).deletedAt && !(p as any).archivedAt);

    const scores = await Promise.all(active.map((p: Project) => storage.getMrvScore(p.id).catch(() => undefined)));
    const allRuns = await Promise.all(active.map((p: Project) => storage.getAnalysisRunsByProject(p.id).catch(() => [])));

    const totalProjects = active.length;
    const totalAreaHa = active.reduce((sum: number, p: Project) => sum + ((p as any).areaHectares ?? p.area ?? 0), 0);
    const validScores = scores.filter(Boolean);
    const avgHealthScore = validScores.length > 0
      ? Math.round(validScores.reduce((sum, s) => sum + s!.trustScore, 0) / validScores.length)
      : 0;
    const underReview = active.filter((p: Project) => p.status === 'pending' || p.status === 'needs_clarification').length;
    const flatRuns = allRuns.flat();
    const monitoringRuns = flatRuns.filter((r: any) => r.status === 'complete').length;
    const evidencePackages = flatRuns.filter((r: any) => r.evidencePath).length;
    const totalCO2 = Math.round(active.reduce((sum: number, p: Project) => sum + ((p as any).co2Captured ?? 0), 0));

    return res.json({
      totalProjects,
      totalAreaHa: Math.round(totalAreaHa * 100) / 100,
      avgHealthScore,
      underReview,
      monitoringRuns,
      evidencePackages,
      totalCO2,
    });
  }));

  // GET /api/portfolio/ecosystem-distribution
  app.get("/api/portfolio/ecosystem-distribution", requireAuth, asyncHandler(async (req: AuthRequest, res: any) => {
    const projects = await getPortfolioProjects(req);
    const active = projects.filter((p: Project) => !(p as any).deletedAt && !(p as any).archivedAt);

    const dist: Record<string, { count: number; areaHa: number }> = {};
    for (const p of active) {
      const eco = p.ecosystemType || 'Other';
      if (!dist[eco]) dist[eco] = { count: 0, areaHa: 0 };
      dist[eco].count++;
      dist[eco].areaHa += (p as any).areaHectares ?? p.area ?? 0;
    }

    const totalArea = Object.values(dist).reduce((sum, d) => sum + d.areaHa, 0);
    const distribution = Object.entries(dist).map(([ecosystem, data]) => ({
      ecosystem,
      count: data.count,
      areaHa: Math.round(data.areaHa * 100) / 100,
      percentage: totalArea > 0 ? Math.round((data.areaHa / totalArea) * 1000) / 10 : 0,
    })).sort((a, b) => b.areaHa - a.areaHa);

    return res.json({ distribution, totalArea: Math.round(totalArea * 100) / 100 });
  }));

  // GET /api/portfolio/rankings
  app.get("/api/portfolio/rankings", requireAuth, asyncHandler(async (req: AuthRequest, res: any) => {
    const projects = await getPortfolioProjects(req);
    const active = projects.filter((p: Project) => !(p as any).deletedAt && !(p as any).archivedAt);

    const withScores = await Promise.all(active.map(async (p: Project) => ({
      project: p,
      score: await storage.getMrvScore(p.id).catch(() => undefined),
    })));

    const topPerformers = withScores
      .filter(ps => ps.score && ps.score.trustScore >= 60)
      .sort((a, b) => (b.score?.trustScore ?? 0) - (a.score?.trustScore ?? 0))
      .slice(0, 5)
      .map(ps => ({
        id: ps.project.id,
        name: ps.project.name,
        ecosystemType: ps.project.ecosystemType,
        trustScore: ps.score!.trustScore,
        ndviDeltaPct: ps.score!.ndviDeltaPct,
        areaHa: (ps.project as any).areaHectares ?? ps.project.area,
      }));

    const atRisk = withScores
      .filter(ps => ps.score?.redFlag || ps.project.mrvStatus === 'FAILED' || ps.project.status === 'needs_clarification')
      .slice(0, 5)
      .map(ps => ({
        id: ps.project.id,
        name: ps.project.name,
        ecosystemType: ps.project.ecosystemType,
        trustScore: ps.score?.trustScore ?? 0,
        status: ps.project.status,
        mrvStatus: ps.project.mrvStatus,
        redFlag: ps.score?.redFlag ?? false,
      }));

    const mostImproved = withScores
      .filter(ps => ps.score && (ps.score.ndviDeltaPct ?? 0) > 0)
      .sort((a, b) => (b.score?.ndviDeltaPct ?? 0) - (a.score?.ndviDeltaPct ?? 0))
      .slice(0, 5)
      .map(ps => ({
        id: ps.project.id,
        name: ps.project.name,
        ecosystemType: ps.project.ecosystemType,
        trustScore: ps.score!.trustScore,
        ndviDeltaPct: ps.score!.ndviDeltaPct,
      }));

    return res.json({ topPerformers, atRisk, mostImproved });
  }));

  // GET /api/portfolio/alerts
  app.get("/api/portfolio/alerts", requireAuth, asyncHandler(async (req: AuthRequest, res: any) => {
    const projects = await getPortfolioProjects(req);
    const active = projects.filter((p: Project) => !(p as any).deletedAt && !(p as any).archivedAt);
    const now = new Date();
    const alerts: any[] = [];

    for (const p of active) {
      const score = await storage.getMrvScore(p.id).catch(() => undefined);

      if (score?.redFlag) {
        alerts.push({ type: 'red_flag', severity: 'critical', projectId: p.id, projectName: p.name,
          message: `Red flag in ${p.name} — MRV trust score critically low` });
      }
      if (p.mrvStatus === 'FAILED') {
        alerts.push({ type: 'mrv_failed', severity: 'critical', projectId: p.id, projectName: p.name,
          message: `Monitoring run failed for ${p.name}` });
      }
      if (p.status === 'needs_clarification') {
        alerts.push({ type: 'validation_failure', severity: 'critical', projectId: p.id, projectName: p.name,
          message: `${p.name} requires clarification from verifier` });
      }
      if (score && score.ndviDeltaPct != null && score.ndviDeltaPct < -5) {
        alerts.push({ type: 'declining_ndvi', severity: 'warning', projectId: p.id, projectName: p.name,
          message: `NDVI declining ${Math.abs(score.ndviDeltaPct).toFixed(1)}% in ${p.name}` });
      }
      if ((p as any).nextMonitoringDue && new Date((p as any).nextMonitoringDue) < now && p.mrvStatus !== 'RUNNING') {
        alerts.push({ type: 'monitoring_overdue', severity: 'warning', projectId: p.id, projectName: p.name,
          message: `Monitoring overdue for ${p.name} since ${new Date((p as any).nextMonitoringDue).toLocaleDateString()}` });
      }
      const runs = await storage.getAnalysisRunsByProject(p.id).catch(() => []);
      if (runs.length === 0 && p.status === 'verified') {
        alerts.push({ type: 'no_evidence', severity: 'info', projectId: p.id, projectName: p.name,
          message: `No evidence packages generated yet for ${p.name}` });
      }
    }

    const severityOrder = { critical: 0, warning: 1, info: 2 } as const;
    alerts.sort((a, b) => severityOrder[a.severity as keyof typeof severityOrder] - severityOrder[b.severity as keyof typeof severityOrder]);
    return res.json({ alerts, count: alerts.length });
  }));

  // GET /api/portfolio/insights
  app.get("/api/portfolio/insights", requireAuth, asyncHandler(async (req: AuthRequest, res: any) => {
    const projects = await getPortfolioProjects(req);
    const active = projects.filter((p: Project) => !(p as any).deletedAt && !(p as any).archivedAt);

    const scores = await Promise.all(active.map((p: Project) => storage.getMrvScore(p.id).catch(() => undefined)));
    const validScores = scores.filter(Boolean);

    const totalArea = active.reduce((sum: number, p: Project) => sum + ((p as any).areaHectares ?? p.area ?? 0), 0);
    const verifiedCount = active.filter((p: Project) => p.status === 'verified').length;
    const pendingCount = active.filter((p: Project) => p.status === 'pending').length;
    const avgHealth = validScores.length > 0
      ? Math.round(validScores.reduce((sum, s) => sum + s!.trustScore, 0) / validScores.length)
      : 0;
    const totalCO2 = Math.round(active.reduce((sum: number, p: Project) => sum + ((p as any).co2Captured ?? 0), 0));
    const improving = validScores.filter(s => (s!.ndviDeltaPct ?? 0) > 0).length;

    const insights: { type: string; text: string }[] = [];

    if (active.length > 0) {
      insights.push({ type: 'coverage',
        text: `Portfolio spans ${totalArea.toFixed(0)} ha across ${active.length} project${active.length > 1 ? 's' : ''}.` });
    }
    if (verifiedCount > 0) {
      const pct = Math.round((verifiedCount / active.length) * 100);
      insights.push({ type: 'verification',
        text: `${verifiedCount} of ${active.length} projects verified (${pct}% verification rate).` });
    }
    if (pendingCount > 0) {
      insights.push({ type: 'review',
        text: `${pendingCount} project${pendingCount > 1 ? 's' : ''} awaiting verification review.` });
    }
    if (avgHealth > 0) {
      const label = avgHealth >= 75 ? 'strong' : avgHealth >= 50 ? 'moderate' : 'low';
      insights.push({ type: 'health',
        text: `Average portfolio health score is ${avgHealth}/100 (${label}).` });
    }
    if (improving > 0 && validScores.length > 0) {
      insights.push({ type: 'vegetation',
        text: `${improving} of ${validScores.length} monitored projects showing positive NDVI growth.` });
    }
    if (totalCO2 > 0) {
      insights.push({ type: 'carbon',
        text: `Total estimated CO₂ sequestration potential: ${totalCO2.toLocaleString()} tonnes.` });
    }

    return res.json({ insights });
  }));

  // GET /api/portfolio/projects-geo
  app.get("/api/portfolio/projects-geo", requireAuth, asyncHandler(async (req: AuthRequest, res: any) => {
    const projects = await getPortfolioProjects(req);
    const active = projects.filter((p: Project) => !(p as any).deletedAt && !(p as any).archivedAt && (p as any).landBoundary);

    const features = await Promise.all(active.map(async (p: Project) => {
      let boundary: any[] = [];
      try { boundary = JSON.parse((p as any).landBoundary!); } catch { return null; }
      const score = await storage.getMrvScore(p.id).catch(() => undefined);
      return {
        id: p.id,
        name: p.name,
        ecosystemType: p.ecosystemType,
        status: p.status,
        areaHa: (p as any).areaHectares ?? p.area,
        trustScore: score?.trustScore ?? null,
        boundary,
      };
    }));

    return res.json({ features: features.filter(Boolean) });
  }));

  // ─── Monitoring Scheduler & Automation (PHASE OPS-1) ─────────────────────────
  // Additive, read/derivation layer over project records. Does NOT trigger MRV.

  // Resolve which projects a user may see for monitoring (contributor: own; staff: all).
  async function getMonitoringProjects(req: AuthRequest): Promise<Project[]> {
    const user = req.user!;
    if (user.role === "contributor") {
      return storage.getProjectsByUserId(user.id);
    }
    return storage.getAllProjects();
  }

  // GET /api/monitoring/schedule — derived schedule snapshots for visible projects
  app.get("/api/monitoring/schedule", requireAuth, asyncHandler(async (req: AuthRequest, res: any) => {
    const projects = await getMonitoringProjects(req);
    const snapshots = deriveScheduleSnapshots(projects);
    const summary = buildMonitoringSummary(snapshots);
    return res.json({ snapshots, summary, frequencies: MONITORING_FREQUENCIES });
  }));

  // GET /api/monitoring/calendar — calendar events (due + completed) for visible projects
  app.get("/api/monitoring/calendar", requireAuth, asyncHandler(async (req: AuthRequest, res: any) => {
    const projects = await getMonitoringProjects(req);
    const snapshots = deriveScheduleSnapshots(projects);
    return res.json({ events: buildCalendarEvents(snapshots) });
  }));

  // GET /api/monitoring/queue — operations monitoring queue (verifier/admin only)
  app.get("/api/monitoring/queue", requireAuth, requireRole("verifier", "admin"), asyncHandler(async (_req: AuthRequest, res: any) => {
    const projects = await storage.getAllProjects();
    const snapshots = deriveScheduleSnapshots(projects);
    const queue = buildMonitoringQueue(snapshots);
    // Queue-ready selection prepared for a future AWS worker (NOT executed here).
    const pending = selectDueForExecution(snapshots);
    return res.json({ queue, pending, summary: buildMonitoringSummary(snapshots) });
  }));

  // PATCH /api/projects/:id/monitoring-schedule — update frequency / enabled / next date
  app.patch("/api/projects/:id/monitoring-schedule", requireAuth, asyncHandler(async (req: AuthRequest, res: any) => {
    const { id } = req.params;
    if (!isValidUUID(id)) {
      return res.status(400).json({ message: "Invalid project id" });
    }
    const project = await storage.getProject(id);
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }
    const user = req.user!;
    const isOwner = project.userId === user.id;
    const isStaff = user.role === "verifier" || user.role === "admin";
    if (!isOwner && !isStaff) {
      return res.status(403).json({ message: "Not authorised to modify this schedule" });
    }

    const scheduleSchema = z.object({
      monitoringFrequency: z.enum(["weekly", "biweekly", "monthly", "quarterly", "yearly"]).optional(),
      monitoringEnabled: z.boolean().optional(),
      nextMonitoringDue: z.string().datetime().optional(),
    });
    const parsed = scheduleSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid schedule payload", errors: parsed.error.flatten() });
    }

    const updates: Partial<Project> = {};
    if (parsed.data.monitoringFrequency !== undefined) {
      const freq = normalizeFrequency(parsed.data.monitoringFrequency);
      updates.monitoringFrequency = freq;
      // If no explicit next date provided, recompute from now so the change takes effect.
      if (parsed.data.nextMonitoringDue === undefined && !project.nextMonitoringDue) {
        updates.nextMonitoringDue = computeNextMonitoringDate(new Date(), freq);
      }
    }
    if (parsed.data.monitoringEnabled !== undefined) {
      updates.monitoringEnabled = parsed.data.monitoringEnabled;
    }
    if (parsed.data.nextMonitoringDue !== undefined) {
      updates.nextMonitoringDue = new Date(parsed.data.nextMonitoringDue);
    }

    const updated = await storage.updateProject(id, updates);
    if (!updated) {
      return res.status(404).json({ message: "Project not found" });
    }
    const snapshot = deriveScheduleSnapshots([updated])[0] ?? null;
    return res.json({ ok: true, snapshot });
  }));

  // ─── Review Threads & Clarification Workflow (PHASE OPS-2) ───────────────────
  // Additive collaborative verification layer. Existing approve/reject/clarify
  // status flow is untouched; this adds threaded discussion on top.

  const ATTACHMENT_MIME_ALLOW = new Set([
    "application/pdf",
    "image/jpeg",
    "image/jpg",
    "image/png",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
  ]);

  // Returns the project if the requester may participate (owner or staff), else null.
  async function getReviewableProject(req: AuthRequest, projectId: string): Promise<Project | null> {
    const project = await storage.getProject(projectId);
    if (!project) return null;
    const user = req.user!;
    const isStaff = user.role === "verifier" || user.role === "admin";
    const isOwner = project.userId === user.id;
    return isStaff || isOwner ? project : null;
  }

  async function resolveAuthor(req: AuthRequest): Promise<{ id: string; name: string; role: string }> {
    const user = req.user!;
    const record = await storage.getUser(user.id).catch(() => undefined);
    return { id: user.id, name: record?.name ?? "Unknown", role: user.role };
  }

  // Persist multipart attachments (graceful fallback when object storage is off).
  async function processAttachments(req: any): Promise<Attachment[]> {
    const files = (req.files ?? []) as Express.Multer.File[];
    if (!files.length) return [];
    const storageConfigured = Boolean(process.env.PRIVATE_OBJECT_DIR);
    const out: Attachment[] = [];
    for (const file of files) {
      if (!ATTACHMENT_MIME_ALLOW.has(file.mimetype)) continue;
      let url: string | null = null;
      if (storageConfigured) {
        try {
          const objectStorage = new ObjectStorageService();
          const fileName = `review-${Date.now()}-${file.originalname}`;
          url = await objectStorage.uploadToPrivate(fileName, file.buffer, file.mimetype);
        } catch (err) {
          console.error("[Review] attachment upload failed", err);
        }
      }
      out.push({ name: file.originalname, url, size: file.size, mimetype: file.mimetype });
    }
    return out;
  }

  // GET thread (comments + clarifications) — owner or staff
  app.get("/api/projects/:id/review-thread", requireAuth, asyncHandler(async (req: AuthRequest, res: any) => {
    const { id } = req.params;
    if (!isValidUUID(id)) return res.status(400).json({ error: "Invalid project id" });
    const project = await getReviewableProject(req, id);
    if (!project) return res.status(403).json({ error: "Not authorised to view this review thread" });
    const thread = await reviewService.getThread(id);
    return res.json(thread);
  }));

  // GET review timeline — owner or staff
  app.get("/api/projects/:id/review-timeline", requireAuth, asyncHandler(async (req: AuthRequest, res: any) => {
    const { id } = req.params;
    if (!isValidUUID(id)) return res.status(400).json({ error: "Invalid project id" });
    const project = await getReviewableProject(req, id);
    if (!project) return res.status(403).json({ error: "Not authorised" });
    const timeline = await reviewService.getTimeline(id);
    return res.json({ projectId: id, timeline });
  }));

  // POST general comment / reply (with optional attachments) — owner or staff
  app.post("/api/projects/:id/review-comments", requireAuth, upload.array("attachments", 5), asyncHandler(async (req: AuthRequest, res: any) => {
    const { id } = req.params;
    if (!isValidUUID(id)) return res.status(400).json({ error: "Invalid project id" });
    const project = await getReviewableProject(req, id);
    if (!project) return res.status(403).json({ error: "Not authorised to comment on this project" });
    const parsed = reviewCommentSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Invalid comment", details: parsed.error.flatten() });
    const author = await resolveAuthor(req);
    const attachments = await processAttachments(req);
    const comment = await reviewService.addComment({
      projectId: id,
      projectName: project.name,
      author,
      body: parsed.data.body,
      parentId: parsed.data.parentId ?? null,
      attachments,
    });
    return res.status(201).json({ comment });
  }));

  // POST clarification request — verifier/admin
  app.post("/api/projects/:id/clarifications", requireAuth, requireRole("verifier", "admin"), asyncHandler(async (req: AuthRequest, res: any) => {
    const { id } = req.params;
    if (!isValidUUID(id)) return res.status(400).json({ error: "Invalid project id" });
    const project = await storage.getProject(id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    const parsed = clarificationRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Invalid clarification", details: parsed.error.flatten() });
    const author = await resolveAuthor(req);
    const clarification = await reviewService.requestClarification({
      projectId: id,
      author,
      body: parsed.data.body,
      category: parsed.data.category,
    });
    return res.status(201).json({ clarification });
  }));

  // POST contributor response to a clarification (with attachments) — owner or staff
  app.post("/api/clarifications/:commentId/respond", requireAuth, upload.array("attachments", 5), asyncHandler(async (req: AuthRequest, res: any) => {
    const { commentId } = req.params;
    if (!isValidUUID(commentId)) return res.status(400).json({ error: "Invalid clarification id" });
    const existing = await reviewRepository.getById(commentId);
    if (!existing || existing.kind !== "clarification") return res.status(404).json({ error: "Clarification not found" });
    const project = await getReviewableProject(req, existing.projectId);
    if (!project) return res.status(403).json({ error: "Not authorised to respond" });
    const parsed = clarificationResponseSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Invalid response", details: parsed.error.flatten() });
    const author = await resolveAuthor(req);
    const attachments = await processAttachments(req);
    const result = await reviewService.submitResponse({ clarificationId: commentId, author, body: parsed.data.body, attachments });
    if (!result) return res.status(404).json({ error: "Clarification not found" });
    return res.status(201).json(result);
  }));

  // POST clarification lifecycle transitions — verifier/admin
  app.post("/api/clarifications/:commentId/resolve", requireAuth, requireRole("verifier", "admin"), asyncHandler(async (req: AuthRequest, res: any) => {
    const author = await resolveAuthor(req);
    const updated = await reviewService.resolveClarification(req.params.commentId, author);
    if (!updated) return res.status(404).json({ error: "Clarification not found" });
    return res.json({ clarification: updated });
  }));

  app.post("/api/clarifications/:commentId/reopen", requireAuth, requireRole("verifier", "admin"), asyncHandler(async (req: AuthRequest, res: any) => {
    const author = await resolveAuthor(req);
    const updated = await reviewService.reopenClarification(req.params.commentId, author);
    if (!updated) return res.status(404).json({ error: "Clarification not found" });
    return res.json({ clarification: updated });
  }));

  app.post("/api/clarifications/:commentId/acknowledge", requireAuth, requireRole("verifier", "admin"), asyncHandler(async (req: AuthRequest, res: any) => {
    const author = await resolveAuthor(req);
    const updated = await reviewService.acknowledgeClarification(req.params.commentId, author);
    if (!updated) return res.status(404).json({ error: "Clarification not found" });
    return res.json({ clarification: updated });
  }));

  // POST archive (audit-safe; never deletes) — verifier/admin
  app.post("/api/review-comments/:commentId/archive", requireAuth, requireRole("verifier", "admin"), asyncHandler(async (req: AuthRequest, res: any) => {
    const author = await resolveAuthor(req);
    const updated = await reviewService.archiveComment(req.params.commentId, author);
    if (!updated) return res.status(404).json({ error: "Comment not found" });
    return res.json({ comment: updated });
  }));

  // GET review inbox (aggregate clarifications) — verifier/admin
  app.get("/api/review/inbox", requireAuth, requireRole("verifier", "admin"), asyncHandler(async (_req: AuthRequest, res: any) => {
    const inbox = await reviewService.getInbox();
    return res.json(inbox);
  }));





  const httpServer = createServer(app);
  return httpServer;
}
