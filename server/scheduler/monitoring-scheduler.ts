import { monitoringOrchestratorService } from "../mrv/monitoring-orchestrator";

interface ScheduledTask {
  stop: () => void;
}

export class MonitoringSchedulerService {
  private tasks: ScheduledTask[] = [];
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    try {
      const cron = require("node-cron");
      const task = cron.schedule("0 */6 * * *", async () => {
        await monitoringOrchestratorService.processDueProjects(50);
      });
      this.tasks.push({ stop: () => task.stop() });
      console.log("[MRV:Scheduler] node-cron scheduler initialized.");
    } catch (error: unknown) {
      console.warn("[MRV:Scheduler] node-cron unavailable; using interval fallback.", error);
      const interval = setInterval(async () => {
        await monitoringOrchestratorService.processDueProjects(50);
      }, 6 * 60 * 60 * 1000);
      this.tasks.push({ stop: () => clearInterval(interval) });
    }
  }

  stopAll() {
    for (const task of this.tasks) {
      task.stop();
    }
    this.tasks = [];
    this.started = false;
  }
}

export const monitoringSchedulerService = new MonitoringSchedulerService();
