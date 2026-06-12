import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import type { User, InsertUser, Project, InsertProject, MrvScore, NdviMeasurement, MrvAuditLog, AnalysisRun } from "@shared/schema";
import { users, projects, mrvScores, ndviMeasurements, mrvAuditLog, analysisRuns } from "@shared/schema";
import { eq, desc, sql } from "drizzle-orm";
import type { AnalysisRunRecord, EvidenceRunStatus } from "./evidence/evidenceTypes";

// Type for project creation with calculated carbon values
export type InsertProjectWithCarbon = InsertProject & {
  annualCO2: number;
  lifetimeCO2: number;
  co2Captured: number
};

export interface IStorage {
  // Users
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser & { role?: string }): Promise<User>;
  getAllUsers(): Promise<User[]>;
  getUsersByRole(role: string): Promise<User[]>;
  updateUser(id: string, updates: Partial<User>): Promise<User | undefined>;

  // Projects
  getProject(id: string): Promise<Project | undefined>;
  getProjectsByUserId(userId: string): Promise<Project[]>;
  getProjectsByStatus(status: string): Promise<Project[]>;
  getProjectsByVerifierId(verifierId: string): Promise<Project[]>;
  getVerifiedProjectsByVerifierId(verifierId: string): Promise<Project[]>;
  getAllProjects(): Promise<Project[]>;
  createProject(project: InsertProjectWithCarbon): Promise<Project>;
  updateProject(id: string, updates: Partial<Project>): Promise<Project | undefined>;

  // Admin Ledger & Governance
  getTopContributors(): Promise<any[]>;
  issueWarning(data: { contributorId: string; message: string; severity: string }): Promise<any>;
  getWarningsByContributorId(contributorId: string): Promise<any[]>;

  // MRV System
  getMrvScore(projectId: string): Promise<MrvScore | undefined>;
  createMrvScore(scoreData: any): Promise<MrvScore>;
  createNdviMeasurement(data: any): Promise<NdviMeasurement>;
  getNdviMeasurements(projectId: string): Promise<NdviMeasurement[]>;
  updateProjectMrvStatus(projectId: string, status: string): Promise<void>;

  // Evidence Package — Analysis Runs
  createAnalysisRun(data: { runId: string; projectId: string; evidencePath?: string }): Promise<AnalysisRunRecord>;
  getAnalysisRun(runId: string): Promise<AnalysisRunRecord | undefined>;
  getAnalysisRunsByProject(projectId: string): Promise<AnalysisRunRecord[]>;
  updateAnalysisRun(runId: string, updates: { status?: EvidenceRunStatus; completedAt?: Date; evidencePath?: string }): Promise<void>;
}

export class MemStorage implements IStorage {
  private users: Map<string, User>;
  private projects: Map<string, Project>;
  private warnings: Map<string, any>;

  constructor() {
    this.users = new Map();
    this.projects = new Map();
    this.warnings = new Map();
    this.initializeData();
  }

  private initializeData() {
    const adminId = randomUUID();
    const verifier1Id = randomUUID();
    const aliceId = randomUUID();
    const bobId = randomUUID();

    // Hash passwords synchronously during initialization
    this.users.set(adminId, {
      id: adminId,
      name: 'Admin User',
      email: 'admin@bluecarbon.com',
      password: bcrypt.hashSync('admin123', 12),
      role: 'admin',
      username: 'admin',
      location: null,
      creditsPurchased: null,
      rewardPoints: 0,
      deletedAt: null,
    });

    this.users.set(verifier1Id, {
      id: verifier1Id,
      name: 'Verifier One',
      email: 'verifier1@bluecarbon.com',
      password: bcrypt.hashSync('verifier123', 12),
      role: 'verifier',
      username: 'verifier1',
      location: null,
      creditsPurchased: null,
      rewardPoints: 0,
      deletedAt: null,
    });

    this.users.set(aliceId, {
      id: aliceId,
      name: 'Alice Johnson',
      email: 'alice@bluecarbon.com',
      password: bcrypt.hashSync('password123', 12),
      role: 'contributor',
      username: 'alice',
      location: 'California, USA',
      creditsPurchased: null,
      rewardPoints: 0,
      deletedAt: null,
    });

    this.users.set(bobId, {
      id: bobId,
      name: 'Bob Smith',
      email: 'bob@bluecarbon.com',
      password: bcrypt.hashSync('password123', 12),
      role: 'contributor',
      username: 'bob',
      location: 'New York, USA',
      creditsPurchased: 0,
      rewardPoints: 0,
      deletedAt: null,
    });
  }

  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find((user) => user.email === email);
  }

  async createUser(insertUser: InsertUser & { role?: string }): Promise<User> {
    const id = randomUUID();
    // Hash password before storing
    const hashedPassword = await bcrypt.hash(insertUser.password, 12);
    const user: User = {
      ...insertUser,
      id,
      password: hashedPassword,
      role: (insertUser.role as any) || 'contributor',
      username: null,
      location: insertUser.location || null,
      creditsPurchased: insertUser.role === 'buyer' ? 0 : null,
      rewardPoints: 0,
      deletedAt: null,
    };
    this.users.set(id, user);
    return user;
  }

  async getAllUsers(): Promise<User[]> {
    return Array.from(this.users.values());
  }

  async getUsersByRole(role: string): Promise<User[]> {
    return Array.from(this.users.values()).filter((user) => user.role === role);
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User | undefined> {
    const user = this.users.get(id);
    if (!user) return undefined;
    const updated = { ...user, ...updates };
    this.users.set(id, updated);
    return updated;
  }

  async getProject(id: string): Promise<Project | undefined> {
    return this.projects.get(id);
  }

  async getProjectsByUserId(userId: string): Promise<Project[]> {
    return Array.from(this.projects.values()).filter((p) => p.userId === userId);
  }

  async getProjectsByStatus(status: string): Promise<Project[]> {
    return Array.from(this.projects.values()).filter((p) => p.status === status);
  }

  async getProjectsByVerifierId(verifierId: string): Promise<Project[]> {
    return Array.from(this.projects.values()).filter((p) => p.verifierId === verifierId);
  }

  async getVerifiedProjectsByVerifierId(verifierId: string): Promise<Project[]> {
    const statuses = ["verified", "rejected", "needs_clarification"];
    return Array.from(this.projects.values()).filter(
      (p) => p.verifierId === verifierId && statuses.includes(p.status)
    ).sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime());
  }

  async getAllProjects(): Promise<Project[]> {
    return Array.from(this.projects.values());
  }

  async createProject(insertProject: InsertProjectWithCarbon): Promise<Project> {
    console.log("[Storage:Mem] createProject started", {
      userId: insertProject.userId,
      name: insertProject.name,
      hasBoundary: Boolean(insertProject.landBoundary),
    });
    const id = randomUUID();
    const project: Project = {
      ...insertProject,
      id,
      status: "pending",
      verifierId: null,
      rejectionReason: null,
      clarificationNote: null,
      proofFileUrl: insertProject.proofFileUrl || null,
      plantationType: insertProject.plantationType || null,
      landBoundary: insertProject.landBoundary || null,
      polygon: null,
      centroid: (insertProject as any).centroid ?? null,
      bbox: (insertProject as any).bbox ?? null,
      areaHectares: (insertProject as any).areaHectares ?? null,
      perimeterKm: (insertProject as any).perimeterKm ?? null,
      country: (insertProject as any).country ?? null,
      adminRegion: (insertProject as any).adminRegion ?? null,
      timezone: null,
      monitoringFrequency: "quarterly",
      nextMonitoringDue: null,
      lastMonitoringDate: null,
      monitoringEnabled: true,
      baselineCompletedAt: null,
      registryId: null,
      archivedAt: null,
      mrvStatus: insertProject.mrvStatus ?? "NONE",
      creditsEarned: 0,
      submittedAt: new Date(),
      isListed: true,
      deletedAt: null,
    };
    this.projects.set(id, project);
    console.log("[Storage:Mem] createProject completed", { projectId: id, status: project.status });
    return project;
  }

  async updateProject(id: string, updates: Partial<Project>): Promise<Project | undefined> {
    const project = this.projects.get(id);
    if (!project) return undefined;
    const updated = { ...project, ...updates };
    this.projects.set(id, updated);
    return updated;
  }



  async getTopContributors(): Promise<any[]> {
    const contributorMap = new Map<string, any>();
    for (const project of this.projects.values()) {
      const stats = contributorMap.get(project.userId) || { id: project.userId, name: (this.users.get(project.userId)?.name || 'Unknown'), projects: 0, credits: 0 };
      stats.projects += 1;
      stats.credits += project.lifetimeCO2;
      contributorMap.set(project.userId, stats);
    }
    return Array.from(contributorMap.values()).sort((a, b) => b.credits - a.credits);
  }

  async issueWarning(data: { contributorId: string; message: string; severity: string }): Promise<any> {
    const id = randomUUID();
    const warning = { ...data, id, date: new Date() };
    this.warnings.set(id, warning);
    return warning;
  }

  async getWarningsByContributorId(contributorId: string): Promise<any[]> {
    return Array.from(this.warnings.values()).filter(w => w.contributorId === contributorId);
  }

  // MRV System (MemStorage stubs)
  private memScores = new Map<string, MrvScore>();
  private memNdvi: NdviMeasurement[] = [];
  async getMrvScore(projectId: string): Promise<MrvScore | undefined> {
    return Array.from(this.memScores.values()).find(s => s.projectId === projectId);
  }
  async createMrvScore(scoreData: any): Promise<MrvScore> {
    const id = Date.now();
    const score: MrvScore = {
      ...scoreData,
      id,
      scoredAt: new Date(),
    };
    this.memScores.set(id.toString(), score);
    return score;
  }
  async createNdviMeasurement(data: any): Promise<NdviMeasurement> {
    const record = {
      id: Date.now(),
      projectId: data.projectId,
      ndviMean: data.ndviMean ?? data.NDVI ?? 0,
      ndviMin: data.ndviMin ?? null,
      ndviMax: data.ndviMax ?? null,
      cloudCoverPct: data.cloudCoverPct ?? null,
      satelliteSource: data.satelliteSource ?? 'Sentinel-2',
      polygon: data.polygon ?? null,
      rawGeeResponse: data.rawGeeResponse ?? null,
      measuredAt: new Date(),
      createdAt: new Date(),
    } as NdviMeasurement;
    this.memNdvi.push(record);
    return record;
  }
  async getNdviMeasurements(projectId: string): Promise<NdviMeasurement[]> {
    return this.memNdvi.filter(m => m.projectId === projectId);
  }
  async updateProjectMrvStatus(projectId: string, status: string): Promise<void> {
    const project = this.projects.get(projectId);
    if (project) {
      project.mrvStatus = status;
    }
  }

  // Analysis Runs (MemStorage)
  private memAnalysisRuns = new Map<string, AnalysisRunRecord>();

  async createAnalysisRun(data: { runId: string; projectId: string; evidencePath?: string }): Promise<AnalysisRunRecord> {
    const record: AnalysisRunRecord = {
      id: randomUUID(),
      runId: data.runId,
      projectId: data.projectId,
      status: "created",
      startedAt: new Date(),
      completedAt: null,
      evidencePath: data.evidencePath ?? null,
      createdAt: new Date(),
    };
    this.memAnalysisRuns.set(data.runId, record);
    return record;
  }

  async getAnalysisRun(runId: string): Promise<AnalysisRunRecord | undefined> {
    return this.memAnalysisRuns.get(runId);
  }

  async getAnalysisRunsByProject(projectId: string): Promise<AnalysisRunRecord[]> {
    return Array.from(this.memAnalysisRuns.values())
      .filter((r) => r.projectId === projectId)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }

  async updateAnalysisRun(runId: string, updates: { status?: EvidenceRunStatus; completedAt?: Date; evidencePath?: string }): Promise<void> {
    const record = this.memAnalysisRuns.get(runId);
    if (record) {
      Object.assign(record, updates);
    }
  }
}

// Database Storage implementation using Drizzle ORM
export class DbStorage implements IStorage {
  private db: any;
  private projectColumnsCache: Set<string> | null = null;

  constructor(database: any) {
    this.db = database;
  }

  private asDate(value: unknown): Date | null {
    if (!value) return null;
    return value instanceof Date ? value : new Date(String(value));
  }

  private asNumber(value: unknown, fallback = 0): number {
    const numeric = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  private hydrateProject(row: any): Project {
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      location: row.location ? String(row.location) : "PENDING_GEO_ENRICHMENT",
      area: this.asNumber(row.area, 1),
      ecosystemType: String(row.ecosystem_type ?? row.ecosystemType ?? "Other"),
      plantationType: row.plantation_type ?? row.plantationType ?? null,
      annualCO2: this.asNumber(row.annual_co2 ?? row.annualCO2, 0),
      lifetimeCO2: this.asNumber(row.lifetime_co2 ?? row.lifetimeCO2, 0),
      co2Captured: this.asNumber(row.co2_captured ?? row.co2Captured, 0),
      creditsEarned: this.asNumber(row.credits_earned ?? row.creditsEarned, 0),
      status: String(row.status ?? "pending") as any,
      userId: String(row.user_id ?? row.userId),
      proofFileUrl: row.proof_file_url ?? row.proofFileUrl ?? null,
      verifierId: row.verifier_id ?? row.verifierId ?? null,
      rejectionReason: row.rejection_reason ?? row.rejectionReason ?? null,
      clarificationNote: row.clarification_note ?? row.clarificationNote ?? null,
      submittedAt: this.asDate(row.submitted_at ?? row.submittedAt) ?? new Date(),
      landBoundary: row.land_boundary ?? row.landBoundary ?? null,
      polygon: row.polygon ?? null,
      centroid: row.centroid ?? null,
      bbox: row.bbox ?? null,
      areaHectares: row.area_hectares ?? row.areaHectares ?? null,
      perimeterKm: row.perimeter_km ?? row.perimeterKm ?? null,
      country: row.country ?? null,
      adminRegion: row.admin_region ?? row.adminRegion ?? null,
      timezone: row.timezone ?? null,
      monitoringFrequency: row.monitoring_frequency ?? row.monitoringFrequency ?? null,
      nextMonitoringDue: this.asDate(row.next_monitoring_due ?? row.nextMonitoringDue),
      lastMonitoringDate: this.asDate(row.last_monitoring_date ?? row.lastMonitoringDate),
      monitoringEnabled: typeof (row.monitoring_enabled ?? row.monitoringEnabled) === "boolean" ? (row.monitoring_enabled ?? row.monitoringEnabled) : true,
      baselineCompletedAt: this.asDate(row.baseline_completed_at ?? row.baselineCompletedAt),
      registryId: row.registry_id ?? row.registryId ?? null,
      archivedAt: this.asDate(row.archived_at ?? row.archivedAt),
      isListed: typeof (row.is_listed ?? row.isListed) === "boolean" ? (row.is_listed ?? row.isListed) : true,
      mrvStatus: row.mrv_status ?? row.mrvStatus ?? "NONE",
      deletedAt: this.asDate(row.deleted_at ?? row.deletedAt),
    };
  }

  private async queryProjects(whereSql: any = sql``, orderSql: any = sql``): Promise<Project[]> {
    const result = await this.db.execute(sql`
      SELECT row_to_json(project_row) AS project
      FROM (
        SELECT *
        FROM public.projects
        ${whereSql}
        ${orderSql}
      ) AS project_row
    `);

    return (result?.rows ?? []).map((row: any) => this.hydrateProject(row.project));
  }

  private async getProjectColumnNames(): Promise<Set<string>> {
    if (this.projectColumnsCache) {
      return this.projectColumnsCache;
    }

    const result = await this.db.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'projects'
    `);

    this.projectColumnsCache = new Set(
      (result?.rows ?? []).map((row: any) => String(row.column_name)),
    );

    return this.projectColumnsCache;
  }

  private buildProjectInsertValues(
    insertProject: InsertProjectWithCarbon,
    id: string,
    submittedAt: Date,
    availableColumns: Set<string>,
    ultraMinimalMode: boolean,
  ): Record<string, unknown> {
    const columnMap: Array<[keyof Project | string, string, unknown]> = [
      ["id", "id", id],
      ["name", "name", insertProject.name],
      ["description", "description", insertProject.description],
      ["location", "location", insertProject.location],
      ["area", "area", insertProject.area],
      ["ecosystemType", "ecosystem_type", insertProject.ecosystemType],
      ["annualCO2", "annual_co2", insertProject.annualCO2],
      ["lifetimeCO2", "lifetime_co2", insertProject.lifetimeCO2],
      ["co2Captured", "co2_captured", insertProject.co2Captured],
      ["status", "status", "pending"],
      ["userId", "user_id", insertProject.userId],
      ["submittedAt", "submitted_at", submittedAt],
      ["landBoundary", "land_boundary", insertProject.landBoundary ?? null],
      ["proofFileUrl", "proof_file_url", insertProject.proofFileUrl || null],
      ["monitoringFrequency", "monitoring_frequency", (insertProject as any).monitoringFrequency ?? null],
      ["mrvStatus", "mrv_status", (insertProject as any).mrvStatus ?? "NONE"],
      // GIS enrichment columns
      ["areaHectares", "area_hectares", (insertProject as any).areaHectares ?? null],
      ["perimeterKm", "perimeter_km", (insertProject as any).perimeterKm ?? null],
      ["centroid", "centroid", (insertProject as any).centroid ?? null],
      ["bbox", "bbox", (insertProject as any).bbox ?? null],
      ["country", "country", (insertProject as any).country ?? null],
      ["adminRegion", "admin_region", (insertProject as any).adminRegion ?? null],
    ];

    const requiredDbColumns = [
      "id",
      "name",
      "description",
      "location",
      "area",
      "ecosystem_type",
      "annual_co2",
      "lifetime_co2",
      "co2_captured",
      "status",
      "user_id",
      "submitted_at",
    ];

    const missingRequiredColumns = requiredDbColumns.filter((columnName) => !availableColumns.has(columnName));
    if (missingRequiredColumns.length > 0) {
      throw new Error(
        `Projects table is missing required columns for submit: ${missingRequiredColumns.join(", ")}`,
      );
    }

    const values: Record<string, unknown> = {};

    for (const [propertyKey, dbColumnName, value] of columnMap) {
      if (!availableColumns.has(dbColumnName)) {
        continue;
      }

      if (ultraMinimalMode && (dbColumnName === "monitoring_frequency" || dbColumnName === "mrv_status" || dbColumnName === "proof_file_url")) {
        continue;
      }

      values[String(propertyKey)] = value;
    }

    return values;
  }

  async getUser(id: string): Promise<User | undefined> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await this.db.select().from(users).where(eq(users.email, email));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser & { role?: string }): Promise<User> {
    const id = randomUUID();
    const hashedPassword = await bcrypt.hash(insertUser.password, 12);
    const [user] = await this.db
      .insert(users)
      .values({
        ...insertUser,
        id,
        password: hashedPassword,
        role: (insertUser.role as any) || 'contributor',
        username: null,
      })
      .returning();
    return user;
  }

  async getAllUsers(): Promise<User[]> {
    return await this.db.select().from(users);
  }

  async getUsersByRole(role: string): Promise<User[]> {
    return await this.db.select().from(users).where(eq(users.role, role as any));
  }

  async getProject(id: string): Promise<Project | undefined> {
    const [project] = await this.queryProjects(sql`WHERE id = ${id}`);
    return project;
  }

  async getProjectsByUserId(userId: string): Promise<Project[]> {
    return await this.queryProjects(
      sql`WHERE user_id = ${userId}`,
      sql`ORDER BY submitted_at DESC`,
    );
  }

  async getProjectsByStatus(status: string): Promise<Project[]> {
    return await this.queryProjects(
      sql`WHERE status = ${status}`,
      sql`ORDER BY submitted_at DESC`,
    );
  }

  async getProjectsByVerifierId(verifierId: string): Promise<Project[]> {
    return await this.queryProjects(
      sql`WHERE verifier_id = ${verifierId}`,
      sql`ORDER BY submitted_at DESC`,
    );
  }

  async getVerifiedProjectsByVerifierId(verifierId: string): Promise<Project[]> {
    return await this.queryProjects(
      sql`WHERE verifier_id = ${verifierId} AND status IN ('verified', 'rejected', 'needs_clarification')`,
      sql`ORDER BY submitted_at DESC`,
    );
  }

  async getAllProjects(): Promise<Project[]> {
    return await this.queryProjects(sql``, sql`ORDER BY submitted_at DESC`);
  }

  async createProject(insertProject: InsertProjectWithCarbon): Promise<Project> {
    const startedAt = Date.now();
    console.log("[Storage:DB] createProject started", {
      userId: insertProject.userId,
      name: insertProject.name,
      hasBoundary: Boolean(insertProject.landBoundary),
      boundaryBytes: typeof insertProject.landBoundary === "string" ? insertProject.landBoundary.length : 0,
      hasProofFileUrl: Boolean(insertProject.proofFileUrl),
    });
    const id = randomUUID();
    const submittedAt = new Date();
    const availableColumns = await this.getProjectColumnNames();
    const ultraMinimalMode = true;
    const values = this.buildProjectInsertValues(
      insertProject,
      id,
      submittedAt,
      availableColumns,
      ultraMinimalMode,
    );

    console.log("[Storage:DB] createProject insert plan", {
      availableColumns: Array.from(availableColumns).sort(),
      insertKeys: Object.keys(values),
      ultraMinimalMode,
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const insertPromise = this.db.insert(projects).values(values);
    try {
      await Promise.race([
        insertPromise,
        new Promise<any[]>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("DB insert timeout at projects.insert(). Possible lock/slow query."));
          }, 10_000);
        }),
      ]);
    } catch (error: any) {
      console.error("[Storage:DB] createProject failed", {
        message: error?.message,
        code: error?.code,
        detail: error?.detail,
        hint: error?.hint,
        table: error?.table,
        column: error?.column,
        constraint: error?.constraint,
        insertKeys: Object.keys(values),
        dbMs: Date.now() - startedAt,
      });
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const project = this.hydrateProject({
      id,
      name: insertProject.name,
      description: insertProject.description,
      location: insertProject.location,
      area: insertProject.area,
      ecosystem_type: insertProject.ecosystemType,
      annual_co2: insertProject.annualCO2,
      lifetime_co2: insertProject.lifetimeCO2,
      co2_captured: insertProject.co2Captured,
      credits_earned: 0,
      status: "pending",
      user_id: insertProject.userId,
      proof_file_url: insertProject.proofFileUrl || null,
      verifier_id: null,
      rejection_reason: null,
      clarification_note: null,
      submitted_at: submittedAt,
      land_boundary: insertProject.landBoundary ?? null,
      monitoring_frequency: null,
      mrv_status: ultraMinimalMode ? "NONE" : ((insertProject as any).mrvStatus ?? "NONE"),
      is_listed: true,
    });
    console.log("[Storage:DB] createProject completed", {
      projectId: project.id,
      status: project.status,
      dbMs: Date.now() - startedAt,
    });
    return project;
  }

  async updateProject(id: string, updates: Partial<Project>): Promise<Project | undefined> {
    const [updated] = await this.db
      .update(projects)
      .set(updates)
      .where(eq(projects.id, id))
      .returning();
    return updated || undefined;
  }

  // MRV System (DbStorage)
  async getMrvScore(projectId: string): Promise<MrvScore | undefined> {
    const [score] = await this.db
      .select()
      .from(mrvScores)
      .where(eq(mrvScores.projectId, projectId))
      .orderBy(desc(mrvScores.scoredAt))
      .limit(1);
    return score || undefined;
  }

  async createMrvScore(scoreData: any): Promise<MrvScore> {
    const [score] = await this.db
      .insert(mrvScores)
      .values({ ...scoreData })
      .returning();
    return score;
  }

  async createNdviMeasurement(data: any): Promise<NdviMeasurement> {
    const [record] = await this.db
      .insert(ndviMeasurements)
      .values({
        // id is SERIAL — let PostgreSQL generate it; never pass Date.now() (overflows INTEGER)
        projectId: data.projectId,
        ndviMean: data.ndviMean,
        ndviMin: data.ndviMin ?? null,
        ndviMax: data.ndviMax ?? null,
        cloudCoverPct: data.cloudCoverPct ?? null,
        satelliteSource: data.satelliteSource ?? 'Sentinel-2',
        polygon: data.polygon ?? null,
        rawGeeResponse: data.rawGeeResponse ?? null,
      })
      .returning();
    return record;
  }

  async getNdviMeasurements(projectId: string): Promise<NdviMeasurement[]> {
    return await this.db
      .select()
      .from(ndviMeasurements)
      .where(eq(ndviMeasurements.projectId, projectId))
      .orderBy(ndviMeasurements.measuredAt);
  }

  async updateProjectMrvStatus(projectId: string, status: string): Promise<void> {
    await this.db
      .update(projects)
      .set({ mrvStatus: status })
      .where(eq(projects.id, projectId));
  }



  async updateUser(id: string, updates: Partial<User>): Promise<User | undefined> {
    const [updated] = await this.db
      .update(users)
      .set(updates)
      .where(eq(users.id, id))
      .returning();
    return updated || undefined;
  }



  async getTopContributors(): Promise<any[]> {
    const results = await this.db
      .select({
        id: projects.userId,
        name: users.name,
        projectsCount: sql<number>`count(${projects.id})`,
        credits: sql<number>`sum(${projects.lifetimeCO2})`,
      })
      .from(projects)
      .innerJoin(users, eq(projects.userId, users.id))
      .groupBy(projects.userId, users.name)
      .orderBy(desc(sql`sum(${projects.lifetimeCO2})`));
    return results;
  }

  async issueWarning(data: { contributorId: string; message: string; severity: string }): Promise<any> {
    const { warnings: warningsTable } = await import("@shared/schema");
    const id = randomUUID();
    const [warning] = await this.db
      .insert(warningsTable)
      .values({ ...data, id, date: new Date() })
      .returning();
    return warning;
  }

  async getWarningsByContributorId(contributorId: string): Promise<any[]> {
    const { warnings: warningsTable } = await import("@shared/schema");
    return await this.db.select().from(warningsTable).where(eq(warningsTable.contributorId, contributorId));
  }

  // Analysis Runs (DbStorage)
  async createAnalysisRun(data: { runId: string; projectId: string; evidencePath?: string }): Promise<AnalysisRunRecord> {
    const id = randomUUID();
    const now = new Date();
    try {
      await this.db.execute(sql`
        INSERT INTO public.analysis_runs (id, run_id, project_id, status, started_at, evidence_path, created_at)
        VALUES (${id}, ${data.runId}, ${data.projectId}, 'created', ${now}, ${data.evidencePath ?? null}, ${now})
      `);
    } catch (err) {
      console.warn("[Storage:DB] createAnalysisRun failed (table may not exist yet):", err instanceof Error ? err.message : err);
    }
    return {
      id,
      runId: data.runId,
      projectId: data.projectId,
      status: "created",
      startedAt: now,
      completedAt: null,
      evidencePath: data.evidencePath ?? null,
      createdAt: now,
    };
  }

  async getAnalysisRun(runId: string): Promise<AnalysisRunRecord | undefined> {
    try {
      const result = await this.db.execute(sql`
        SELECT * FROM public.analysis_runs WHERE run_id = ${runId} LIMIT 1
      `);
      const row = result?.rows?.[0];
      if (!row) return undefined;
      return this.hydrateAnalysisRun(row);
    } catch {
      return undefined;
    }
  }

  async getAnalysisRunsByProject(projectId: string): Promise<AnalysisRunRecord[]> {
    try {
      const result = await this.db.execute(sql`
        SELECT * FROM public.analysis_runs WHERE project_id = ${projectId} ORDER BY started_at DESC
      `);
      return (result?.rows ?? []).map((row: any) => this.hydrateAnalysisRun(row));
    } catch {
      return [];
    }
  }

  async updateAnalysisRun(runId: string, updates: { status?: EvidenceRunStatus; completedAt?: Date; evidencePath?: string }): Promise<void> {
    try {
      if (updates.status !== undefined && updates.completedAt !== undefined && updates.evidencePath !== undefined) {
        await this.db.execute(sql`
          UPDATE public.analysis_runs SET status = ${updates.status}, completed_at = ${updates.completedAt}, evidence_path = ${updates.evidencePath} WHERE run_id = ${runId}
        `);
      } else if (updates.status !== undefined && updates.completedAt !== undefined) {
        await this.db.execute(sql`
          UPDATE public.analysis_runs SET status = ${updates.status}, completed_at = ${updates.completedAt} WHERE run_id = ${runId}
        `);
      } else if (updates.status !== undefined) {
        await this.db.execute(sql`
          UPDATE public.analysis_runs SET status = ${updates.status} WHERE run_id = ${runId}
        `);
      } else if (updates.evidencePath !== undefined) {
        await this.db.execute(sql`
          UPDATE public.analysis_runs SET evidence_path = ${updates.evidencePath} WHERE run_id = ${runId}
        `);
      }
    } catch (err) {
      console.warn("[Storage:DB] updateAnalysisRun failed:", err instanceof Error ? err.message : err);
    }
  }

  private hydrateAnalysisRun(row: any): AnalysisRunRecord {
    return {
      id: String(row.id),
      runId: String(row.run_id),
      projectId: String(row.project_id),
      status: String(row.status) as EvidenceRunStatus,
      startedAt: row.started_at instanceof Date ? row.started_at : new Date(row.started_at),
      completedAt: row.completed_at ? (row.completed_at instanceof Date ? row.completed_at : new Date(row.completed_at)) : null,
      evidencePath: row.evidence_path ?? null,
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    };
  }
}

// Storage switcher - use environment variable to choose storage type
async function createStorage(): Promise<IStorage> {
  const useDatabase = process.env.USE_DATABASE === 'true';
  const hasDatabaseUrl = Boolean(process.env.DATABASE_URL?.trim());

  if (useDatabase) {
    if (!hasDatabaseUrl) {
      console.warn('⚠️ USE_DATABASE=true but DATABASE_URL is missing. Falling back to in-memory storage.');
      console.log('✅ Using in-memory storage');
      return new MemStorage();
    }

    try {
      // Dynamically import db so memory mode never initializes a database client.
      const { getDb, getDatabaseModeSummary, getPool } = await import('./db');
      const db = getDb();

      // Force a lightweight connectivity check so dev boot fails cleanly into memory mode.
      await getPool().query('select 1');

      console.log('✅ Using PostgreSQL database storage', getDatabaseModeSummary());
      return new DbStorage(db);
    } catch (error: any) {
      console.error('❌ Database connection failed, falling back to in-memory storage');
      console.error({
        message: error?.message,
        code: error?.code,
        name: error?.name,
      });
      console.error(error);
      console.log('✅ Using in-memory storage');
      return new MemStorage();
    }
  }

  console.log('✅ Using in-memory storage');
  return new MemStorage();
}

export const storage = await createStorage();
