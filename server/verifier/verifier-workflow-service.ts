import { sql } from "drizzle-orm";
import { storage } from "../storage";

export interface EnhancedVerifierObservation {
  type: "VEGETATION_ANOMALY" | "WATER_CONCERN" | "DATA_ISSUE" | "POSITIVE_TREND" | "GENERAL";
  title: string;
  description: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  locationLat?: number;
  locationLng?: number;
}

export interface EnhancedVerifierReviewInput {
  decision: "APPROVED" | "APPROVED_WITH_OBSERVATIONS" | "REVISION_REQUESTED" | "REJECTED";
  overallNotes: string;
  confidenceScore: number;
  recommendedActions: string[];
  nextReviewRecommendation: "STANDARD" | "EXPEDITED" | "EXTENDED";
  dataQualityAssessment?: Record<string, unknown>;
  environmentalAssessment?: Record<string, unknown>;
  restorationProgressAssessment?: Record<string, unknown>;
  observations?: EnhancedVerifierObservation[];
}

class TimelineWriter {
  // Service-only persistence hook. Routes should not write timeline rows directly.
  async add(projectId: string, eventType: string, title: string, payload: Record<string, unknown>) {
    if (!(process.env.USE_DATABASE === "true" && process.env.DATABASE_URL)) return;
    const { db } = await import("../db");
    await db.execute(sql`
      INSERT INTO eco_monitoring.project_timeline_events
        (project_id, event_type, title, description, payload)
      VALUES
        (${projectId}, ${eventType}, ${title}, ${title}, ${JSON.stringify(payload)}::jsonb)
    `);
  }
}

export class VerifierWorkflowService {
  private timeline = new TimelineWriter();
  private isDbMode() {
    return process.env.USE_DATABASE === "true" && Boolean(process.env.DATABASE_URL);
  }

  async assignVerifier(projectId: string, verifierId: string, assignedBy: string) {
    const updated = await storage.updateProject(projectId, { verifierId });
    await this.timeline.add(projectId, "VERIFIER_ASSIGNMENT", "Verifier assigned", {
      verifierId,
      assignedBy,
    });
    return updated;
  }

  async submitEnhancedReview(projectId: string, verifierId: string, review: EnhancedVerifierReviewInput) {
    if (!this.isDbMode()) {
      // TODO(verifier): Add durable memory-backed review cache when DB is unavailable.
      await this.timeline.add(projectId, "VERIFIER_REVIEW", "Enhanced verifier review recorded", {
        verifierId,
        decision: review.decision,
      });
      return { persisted: false };
    }

    const { db } = await import("../db");
    await db.execute(sql`
      INSERT INTO eco_monitoring.verifier_review_records
        (
          project_id,
          verifier_id,
          decision,
          confidence_score,
          overall_notes,
          review_payload,
          recommended_actions,
          next_review_recommendation
        )
      VALUES
        (
          ${projectId},
          ${verifierId},
          ${review.decision},
          ${review.confidenceScore},
          ${review.overallNotes},
          ${JSON.stringify(review)}::jsonb,
          ${JSON.stringify(review.recommendedActions ?? [])}::jsonb,
          ${review.nextReviewRecommendation}
        )
    `);

    await this.timeline.add(projectId, "VERIFIER_REVIEW", "Enhanced verifier review recorded", {
      verifierId,
      decision: review.decision,
      confidenceScore: review.confidenceScore,
    });

    return { persisted: true };
  }
}

export const verifierWorkflowService = new VerifierWorkflowService();
