import { randomUUID } from "crypto";
import type { AnalysisJobPayload } from "./types";
import { mrvEventBus } from "./lifecycle-events";

type AnalysisJobProcessor = (payload: AnalysisJobPayload) => Promise<void>;

type QueueMode = "bull" | "memory";

interface QueueJob {
  data: AnalysisJobPayload;
}

interface QueueAddOptions {
  attempts?: number;
  backoff?: { type: "exponential"; delay: number };
  removeOnComplete?: boolean;
  removeOnFail?: boolean;
}

interface BullLikeQueue {
  add: (name: string, data: AnalysisJobPayload, opts?: QueueAddOptions) => Promise<unknown>;
  process: (name: string, handler: (job: QueueJob) => Promise<void>) => Promise<void> | void;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
}

export class AnalysisQueueService {
  private mode: QueueMode = "memory";
  private queueName = "mrv-analysis";
  private bullQueue: BullLikeQueue | null = null;
  private memoryProcessor: AnalysisJobProcessor | null = null;
  private memoryPending: AnalysisJobPayload[] = [];
  private memoryRunning = false;
  private memoryConcurrency = Math.max(1, Number(process.env.MRV_MEMORY_QUEUE_CONCURRENCY ?? 2));
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      console.warn("[MRV] [QUEUE] REDIS_URL missing. Using in-memory fallback.");
      return;
    }

    try {
      const Bull = require("bull");
      this.bullQueue = new Bull(this.queueName, redisUrl);
      this.mode = "bull";
      console.log("[MRV] [QUEUE] Bull/Redis queue initialized.");
    } catch (error: unknown) {
      console.warn("[MRV] [QUEUE] Bull unavailable. Using in-memory fallback.", error);
      this.mode = "memory";
    }
  }

  async enqueue(job: Omit<AnalysisJobPayload, "jobId">): Promise<{ jobId: string; mode: QueueMode }> {
    const payload: AnalysisJobPayload = {
      ...job,
      jobId: randomUUID(),
      retryCount: 0,
    };

    mrvEventBus.publish({ type: "job.enqueued", payload });

    if (this.mode === "bull" && this.bullQueue) {
      await this.bullQueue.add("analyze", payload, {
        attempts: 3,
        backoff: { type: "exponential", delay: 3000 },
        removeOnComplete: true,
        removeOnFail: false,
      });
      return { jobId: payload.jobId, mode: "bull" };
    }

    this.memoryPending.push(payload);
    void this.flushMemoryQueue();
    return { jobId: payload.jobId, mode: "memory" };
  }

  async registerProcessor(processor: AnalysisJobProcessor): Promise<void> {
    if (this.mode === "bull" && this.bullQueue) {
      this.bullQueue.process("analyze", async (job: QueueJob) => {
        await processor(job.data as AnalysisJobPayload);
      });
      return;
    }

    this.memoryProcessor = processor;
    void this.flushMemoryQueue();
  }

  private activeJobs = 0;

  private async flushMemoryQueue() {
    if (this.memoryRunning || !this.memoryProcessor) return;
    this.memoryRunning = true;

    try {
      while (this.memoryPending.length > 0) {
        const batch = this.memoryPending.splice(0, this.memoryConcurrency);
        await Promise.all(
          batch.map(async (job) => {
            this.activeJobs++;
            try {
              await this.memoryProcessor!(job);
            } finally {
              this.activeJobs--;
            }
          })
        );
      }
    } finally {
      this.memoryRunning = false;
    }
  }

  getStats(): { mode: string; pending: number; active: number } {
    return {
      mode: this.mode,
      pending: this.memoryPending.length,
      active: this.activeJobs,
    };
  }
}

export const analysisQueueService = new AnalysisQueueService();
// Health-service compatible alias
export const analysisQueue = analysisQueueService;
