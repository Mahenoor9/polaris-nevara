import { pgTable, text, varchar, integer, timestamp, real, index, uniqueIndex, boolean } from "drizzle-orm/pg-core";
import { pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ENUM types for PostgreSQL
// ENUM types for PostgreSQL
export const userRoleEnum = pgEnum("user_role", ["admin", "verifier", "contributor"]);
export const projectStatusEnum = pgEnum("project_status", ["pending", "verified", "rejected", "needs_clarification", "IDLE", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]);

// Users table with role-based access
export const users = pgTable("users", {
  id: varchar("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  role: userRoleEnum("role").notNull(), // 'admin' | 'verifier' | 'contributor'
  username: text("username"), // Optional legacy field
  location: text("location"), // Location for contributors
  creditsPurchased: real("credits_purchased").default(0), // For contributors (legacy field)
  rewardPoints: real("reward_points").default(0), // Blue Points reward
  deletedAt: timestamp("deleted_at"), // Soft delete timestamp
});

export const insertUserSchema = createInsertSchema(users).omit({ id: true, role: true, username: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// Projects table
// Task 4.1: Added indexes on userId, status, verifierId for query performance
export const projects = pgTable(
  "projects",
  {
    id: varchar("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    location: text("location").notNull(),
    area: real("area").notNull(), // in hectares
    ecosystemType: text("ecosystem_type").notNull(), // see ECOSYSTEM_TYPES in this file
    plantationType: text("plantation_type"), // Type of plantation for contributors
    annualCO2: real("annual_co2").notNull(), // calculated annual sequestration in tons
    lifetimeCO2: real("lifetime_co2").notNull(), // calculated 20-year total in tons
    co2Captured: real("co2_captured").notNull(), // legacy field, now same as lifetimeCO2
    creditsEarned: real("credits_earned").notNull().default(0), // Credits available for sale (initially = lifetimeCO2)
    // Task 2.1: Added 'needs_clarification' status
    status: projectStatusEnum("status").notNull(), // 'pending' | 'verified' | 'rejected' | 'needs_clarification'
    userId: varchar("user_id").notNull().references(() => users.id),
    proofFileUrl: text("proof_file_url"),
    verifierId: varchar("verifier_id").references(() => users.id),
    rejectionReason: text("rejection_reason"),
    clarificationNote: text("clarification_note"), // Task 2.1: Separate field for clarification messages
    submittedAt: timestamp("submitted_at").notNull(),
    landBoundary: text("land_boundary"), // GIS polygon coordinates as JSON string [[lat,lng], ...]
    polygon: text("polygon"), // PostGIS geometry column (WKT/GeoJSON input via SQL casts)
    centroid: text("centroid"), // PostGIS point geometry
    bbox: text("bbox"), // PostGIS polygon geometry
    areaHectares: real("area_hectares"), // auto-computed from polygon
    perimeterKm: real("perimeter_km"), // auto-computed from polygon
    country: text("country"),
    adminRegion: text("admin_region"),
    timezone: text("timezone"),
    monitoringFrequency: text("monitoring_frequency"), // weekly | biweekly | monthly | quarterly | yearly
    nextMonitoringDue: timestamp("next_monitoring_due"),
    lastMonitoringDate: timestamp("last_monitoring_date"), // OPS-1: last completed monitoring run
    monitoringEnabled: boolean("monitoring_enabled").default(true), // OPS-1: recurring schedule on/off
    baselineCompletedAt: timestamp("baseline_completed_at"),
    registryId: varchar("registry_id", { length: 64 }),
    archivedAt: timestamp("archived_at"),
    isListed: boolean("is_listed").default(true), // Admin can soft delete/hide from marketplace
    mrvStatus: text("mrv_status").default("NONE"), // 'NONE' | 'PENDING' | 'COMPLETED' | 'FAILED'
    deletedAt: timestamp("deleted_at"), // Soft delete timestamp
  },
  (table) => ({
    // Task 4.1: Performance indexes
    userIdIdx: index("projects_user_id_idx").on(table.userId),
    statusIdx: index("projects_status_idx").on(table.status),
    verifierIdIdx: index("projects_verifier_id_idx").on(table.verifierId),
  })
);

export const insertProjectSchema = createInsertSchema(projects).omit({
  id: true,
  status: true,
  verifierId: true,
  rejectionReason: true,
  submittedAt: true,
  annualCO2: true,
  lifetimeCO2: true,
  co2Captured: true,
  polygon: true,
  centroid: true,
  bbox: true,
  areaHectares: true,
  perimeterKm: true,
  country: true,
  adminRegion: true,
  timezone: true,
  monitoringFrequency: true,
  nextMonitoringDue: true,
  lastMonitoringDate: true,
  monitoringEnabled: true,
  baselineCompletedAt: true,
  registryId: true,
  archivedAt: true,
});
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projects.$inferSelect;

// Login schema - now uses email instead of username
export const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});
export type LoginInput = z.infer<typeof loginSchema>;

// Task 1.4: Password complexity requirements
// Enforces: min 8 chars, at least 1 uppercase, 1 lowercase, 1 digit, 1 special character
const passwordComplexitySchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
  .regex(/[a-z]/, "Password must contain at least one lowercase letter")
  .regex(/[0-9]/, "Password must contain at least one number")
  .regex(
    /[^A-Za-z0-9]/,
    "Password must contain at least one special character (e.g. !@#$%)"
  );

// Signup schema - requires name, Gmail address, password, and role selection
export const signupSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string()
    .email("Invalid email address")
    .refine((email) => email.endsWith("@gmail.com"), {
      message: "Please use a Gmail address (@gmail.com)",
    }),
  password: passwordComplexitySchema,
  role: z.enum(["contributor"], {
    errorMap: () => ({ message: "Please select your account type" }),
  }),
});
export type SignupInput = z.infer<typeof signupSchema>;

// ─── Canonical ecosystem type list ─────────────────────────────────────────────
// Single source of truth used by frontend form, backend Zod validators, and carbon calc.
export const ECOSYSTEM_TYPES = [
  'Mangrove Forest',
  'Seagrass Meadow',
  'Salt Marsh',
  'Coastal Wetland',
  'Freshwater Wetland',
  'Lake Restoration',
  'River Restoration',
  'Forest Restoration',
  'Agricultural Regeneration',
  'Mixed Ecosystem',
  'Other / Unknown',
] as const;

export type EcosystemType = typeof ECOSYSTEM_TYPES[number];

// Project submission schema with validation
export const projectSubmissionSchema = insertProjectSchema.extend({
  name: z.string().min(3, "Project name must be at least 3 characters"),
  description: z.string().min(10, "Description must be at least 10 characters"),
  location: z.string().min(2, "Location is required"),
  area: z.number().positive("Area must be positive"),
  ecosystemType: z.enum(ECOSYSTEM_TYPES),
});

// Task 2.1: Standardized rejection reason codes
export const REJECTION_REASON_CODES = [
  "INSUFFICIENT_DOCUMENTATION",
  "INVALID_GIS_BOUNDARY",
  "MRV_INCOMPLETE",
  "OWNERSHIP_UNCLEAR",
  "OTHER",
] as const;

export type RejectionReasonCode = (typeof REJECTION_REASON_CODES)[number];

// Approval/Rejection/Clarification schema
// Task 2.1: 'clarify' action now uses a dedicated clarificationNote field
export const projectReviewSchema = z.object({
  projectId: z.string(),
  action: z.enum(["approve", "reject", "clarify"]),
  rejectionReason: z.enum(REJECTION_REASON_CODES).optional(),
  comment: z.string().optional(),
  clarificationNote: z
    .string()
    .min(10, "Clarification note must be at least 10 characters")
    .optional(),
});
export type ProjectReview = z.infer<typeof projectReviewSchema>;

// Hash verification schema
export const hashVerificationSchema = z.object({
  data: z.string(),
  expectedHash: z.string(),
});
export type HashVerification = z.infer<typeof hashVerificationSchema>;

// ─── Audit Logs Table (Task 1.3) ──────────────────────────────────────────────
// Append-only tamper-resistant log of all sensitive actions.
// IMPORTANT: This table must NEVER have UPDATE or DELETE operations applied to it.
// Indexes on userId and actionType for admin queries; timestamp for chronological ordering.
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: varchar("id").primaryKey(),
    // The user who performed the action (null for system-initiated events)
    userId: varchar("user_id"),
    // Standardized action type — see AuditActionType below
    actionType: text("action_type").notNull(),
    // The type of entity this action was performed on
    entityType: text("entity_type").notNull(),
    // The ID of the entity (project ID, user ID, transaction ID, etc.)
    entityId: varchar("entity_id"),
    // Arbitrary JSON metadata (e.g. IP address, old/new values, reason codes)
    metadata: text("metadata"), // stored as JSON string
    // Immutable creation timestamp — set once, never updated
    timestamp: timestamp("timestamp").notNull(),
  },
  (table) => ({
    userIdIdx: index("audit_logs_user_id_idx").on(table.userId),
    actionTypeIdx: index("audit_logs_action_type_idx").on(table.actionType),
    timestampIdx: index("audit_logs_timestamp_idx").on(table.timestamp),
  })
);

export type AuditLog = typeof auditLogs.$inferSelect;

// Standardized action type constants — exhaustive list of all auditable events
export const AUDIT_ACTION_TYPES = {
  // Authentication
  LOGIN_SUCCESS: "LOGIN_SUCCESS",
  LOGIN_FAILURE: "LOGIN_FAILURE",
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
  SIGNUP: "SIGNUP",

  // Project lifecycle
  PROJECT_SUBMITTED: "PROJECT_SUBMITTED",
  PROJECT_APPROVED: "PROJECT_APPROVED",
  PROJECT_REJECTED: "PROJECT_REJECTED",
  PROJECT_CLARIFICATION_REQUESTED: "PROJECT_CLARIFICATION_REQUESTED",

  // Credits & marketplace
  CREDITS_PURCHASED: "CREDITS_PURCHASED",
  REWARDS_ISSUED: "REWARDS_ISSUED",
  CERTIFICATE_ISSUED: "CERTIFICATE_ISSUED",
  CERTIFICATE_REVOKED: "CERTIFICATE_REVOKED",

  // Administration
  VERIFIER_ASSIGNED: "VERIFIER_ASSIGNED",
  ROLE_CHANGED: "ROLE_CHANGED",

  // Review threads & clarifications (OPS-2)
  REVIEW_COMMENT_ADDED: "REVIEW_COMMENT_ADDED",
  REVIEW_CLARIFICATION_REQUESTED: "REVIEW_CLARIFICATION_REQUESTED",
  REVIEW_CLARIFICATION_RESPONDED: "REVIEW_CLARIFICATION_RESPONDED",
  REVIEW_CLARIFICATION_RESOLVED: "REVIEW_CLARIFICATION_RESOLVED",
  REVIEW_CLARIFICATION_REOPENED: "REVIEW_CLARIFICATION_REOPENED",
  REVIEW_CLARIFICATION_ACKNOWLEDGED: "REVIEW_CLARIFICATION_ACKNOWLEDGED",
  REVIEW_COMMENT_ARCHIVED: "REVIEW_COMMENT_ARCHIVED",
} as const;

export type AuditActionType = (typeof AUDIT_ACTION_TYPES)[keyof typeof AUDIT_ACTION_TYPES];

// ─── Warnings Table ──────────────────────────────────────────────────────────
export const warnings = pgTable("warnings", {
  id: varchar("id").primaryKey(),
  contributorId: varchar("contributor_id").notNull().references(() => users.id),
  message: text("message").notNull(),
  severity: text("severity").notNull(), // 'Low', 'Medium', 'Critical'
  date: timestamp("date").notNull().defaultNow(),
});

export type Warning = typeof warnings.$inferSelect;
// ─── MRV System Tables (New) ────────────────────────────────────────────────
export const ndviMeasurements = pgTable(
  "ndvi_measurements",
  {
    id: integer("id").primaryKey(), // SERIAL in SQL
    projectId: varchar("project_id").notNull().references(() => projects.id, { onDelete: 'cascade' }),
    measuredAt: timestamp("measured_at", { withTimezone: true }).notNull().defaultNow(),
    ndviMean: real("ndvi_mean").notNull(),
    ndviMin: real("ndvi_min"),
    ndviMax: real("ndvi_max"),
    cloudCoverPct: real("cloud_cover_pct"),
    satelliteSource: varchar("satellite_source", { length: 50 }).default('Sentinel-2'),
    polygon: text("polygon"), // Store as JSON string or GeoJSON
    rawGeeResponse: text("raw_gee_response"), // JSON string
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    projectIdIdx: index("idx_ndvi_project_id").on(table.projectId),
    measuredAtIdx: index("idx_ndvi_measured_at").on(table.measuredAt),
  })
);

export const mrvScores = pgTable(
  "mrv_scores",
  {
    id: integer("id").primaryKey(), // SERIAL in SQL
    projectId: varchar("project_id").notNull().references(() => projects.id, { onDelete: 'cascade' }),
    scoredAt: timestamp("scored_at", { withTimezone: true }).defaultNow(),
    trustScore: integer("trust_score").notNull(),
    confidence: varchar("confidence", { length: 10 }), // 'HIGH' | 'MEDIUM' | 'LOW'
    baselineNdvi: real("baseline_ndvi"),
    currentNdvi: real("current_ndvi"),
    ndviDeltaPct: real("ndvi_delta_pct"),
    canopyPct: real("canopy_pct"),
    ecosystemFactor: real("ecosystem_factor"),
    areaHa: real("area_ha"),
    redFlag: boolean("red_flag").default(false),
    dataGapMonths: integer("data_gap_months").default(0),
    reportPdfUrl: text("report_pdf_url"),
    reportHtml: text("report_html"),
    inputHash: varchar("input_hash", { length: 64 }),
    outputHash: varchar("output_hash", { length: 64 }),
    scoringVersion: varchar("scoring_version", { length: 20 }).default('v1.0'),
  },
  (table) => ({
    projectIdIdx: index("idx_mrv_project").on(table.projectId),
    scoredAtIdx: index("idx_mrv_scored_at").on(table.scoredAt),
  })
);

export const mrvAuditLog = pgTable(
  "mrv_audit_log",
  {
    id: integer("id").primaryKey(), // BIGSERIAL in SQL
    loggedAt: timestamp("logged_at", { withTimezone: true }).defaultNow(),
    projectId: varchar("project_id").notNull(),
    eventType: varchar("event_type", { length: 50 }).notNull(),
    payload: text("payload").notNull(), // JSON string
    sha256Hash: varchar("sha256_hash", { length: 64 }).notNull(),
    prevHash: varchar("prev_hash", { length: 64 }),
    scorerVersion: varchar("scorer_version", { length: 20 }),
  },
  (table) => ({
    projectIdIdx: index("idx_audit_project").on(table.projectId),
  })
);

export type NdviMeasurement = typeof ndviMeasurements.$inferSelect;
export type MrvScore = typeof mrvScores.$inferSelect;
export type MrvAuditLog = typeof mrvAuditLog.$inferSelect;

// ─── Analysis Runs Table (Phase 1: Evidence Package) ────────────────────────
export const analysisRuns = pgTable(
  "analysis_runs",
  {
    id: varchar("id").primaryKey(),
    runId: varchar("run_id", { length: 64 }).notNull().unique(),
    projectId: varchar("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("created"), // created | running | complete | failed
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    evidencePath: text("evidence_path"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectIdIdx: index("idx_analysis_runs_project_id").on(table.projectId),
    runIdIdx: index("idx_analysis_runs_run_id").on(table.runId),
  })
);

export type AnalysisRun = typeof analysisRuns.$inferSelect;

// ─── Report Reviews Table (Phase 4C: Report Review Workflow) ────────────────
export const reportReviews = pgTable(
  "report_reviews",
  {
    id: varchar("id").primaryKey(),
    projectId: varchar("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull().references(() => analysisRuns.runId, { onDelete: "cascade" }),
    reportPath: text("report_path").notNull(),
    status: text("status").notNull().default("draft"),
    reviewNotes: text("review_notes"),
    reviewedBy: varchar("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectRunIdx: uniqueIndex("report_reviews_project_run_unique").on(table.projectId, table.runId),
    projectIdIdx: index("idx_report_reviews_project_id").on(table.projectId),
    runIdIdx: index("idx_report_reviews_run_id").on(table.runId),
    statusIdx: index("idx_report_reviews_status").on(table.status),
  })
);

export type ReportReview = typeof reportReviews.$inferSelect;

// ─── Review Threads & Clarifications (PHASE OPS-2) ───────────────────────────
// Collaborative ecological verification: threaded discussions + clarification
// requests permanently attached to a project. AUDIT-SAFE: rows are never
// deleted — only resolved, archived, or superseded.
export const reviewComments = pgTable(
  "review_comments",
  {
    id: varchar("id").primaryKey(),
    projectId: varchar("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    // Null = top-level comment / clarification; set = reply (e.g. a contributor response).
    parentId: varchar("parent_id"),
    authorId: varchar("author_id").notNull().references(() => users.id),
    authorName: text("author_name").notNull(),
    authorRole: text("author_role").notNull(), // contributor | verifier | admin
    body: text("body").notNull(),
    // comment | clarification | response | system
    kind: text("kind").notNull().default("comment"),
    // boundary | ecosystem | monitoring | evidence | document (clarifications only)
    clarificationCategory: text("clarification_category"),
    // open | responded | resolved (clarification lifecycle only; null otherwise)
    status: text("status"),
    // JSON array string: [{ name, url, size, mimetype }]
    attachments: text("attachments"),
    resolvedBy: varchar("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // Audit-safe soft states — never a hard delete.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    supersededById: varchar("superseded_by_id"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectIdIdx: index("idx_review_comments_project_id").on(table.projectId),
    parentIdIdx: index("idx_review_comments_parent_id").on(table.parentId),
    kindIdx: index("idx_review_comments_kind").on(table.kind),
    statusIdx: index("idx_review_comments_status").on(table.status),
  })
);

export type ReviewComment = typeof reviewComments.$inferSelect;

export const CLARIFICATION_CATEGORIES = [
  "boundary",
  "ecosystem",
  "monitoring",
  "evidence",
  "document",
] as const;
export type ClarificationCategory = (typeof CLARIFICATION_CATEGORIES)[number];

export const CLARIFICATION_STATUSES = ["open", "responded", "resolved"] as const;
export type ClarificationStatus = (typeof CLARIFICATION_STATUSES)[number];

export const REVIEW_COMMENT_KINDS = ["comment", "clarification", "response", "system"] as const;
export type ReviewCommentKind = (typeof REVIEW_COMMENT_KINDS)[number];

export const reviewCommentSchema = z.object({
  body: z.string().min(1, "Comment cannot be empty").max(5000),
  parentId: z.string().optional(),
});

export const clarificationRequestSchema = z.object({
  body: z.string().min(1, "Clarification detail is required").max(5000),
  category: z.enum(CLARIFICATION_CATEGORIES),
});

export const clarificationResponseSchema = z.object({
  body: z.string().min(1, "A response is required").max(5000),
});

