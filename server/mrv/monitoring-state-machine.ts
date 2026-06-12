import type { MonitoringState, MonitoringTransition } from "./types";

const STATE_TRANSITIONS: Record<MonitoringState, Partial<Record<MonitoringTransition, MonitoringState>>> = {
  DRAFT: {
    SUBMIT_POLYGON: "POLYGON_SUBMITTED",
    ARCHIVE: "ARCHIVED",
  },
  POLYGON_SUBMITTED: {
    START_GIS_ANALYSIS: "GIS_ANALYSIS_PENDING",
    ARCHIVE: "ARCHIVED",
  },
  GIS_ANALYSIS_PENDING: {
    START_GIS_ANALYSIS: "GIS_ANALYSIS_RUNNING",
    RETRY_GIS_ANALYSIS: "GIS_ANALYSIS_RUNNING",
  },
  GIS_ANALYSIS_RUNNING: {
    GIS_ANALYSIS_SUCCESS: "BASELINE_COMPLETE",
    GIS_ANALYSIS_FAIL: "GIS_ANALYSIS_FAILED",
  },
  GIS_ANALYSIS_FAILED: {
    RETRY_GIS_ANALYSIS: "GIS_ANALYSIS_PENDING",
    ARCHIVE: "ARCHIVED",
  },
  BASELINE_COMPLETE: {
    START_MONITORING: "MONITORING_ACTIVE",
    ARCHIVE: "ARCHIVED",
  },
  MONITORING_ACTIVE: {
    PAUSE_MONITORING: "MONITORING_PAUSED",
    ARCHIVE: "ARCHIVED",
  },
  MONITORING_PAUSED: {
    RESUME_MONITORING: "MONITORING_ACTIVE",
    ARCHIVE: "ARCHIVED",
  },
  ARCHIVED: {},
};

export class MonitoringStateMachine {
  static canTransition(currentState: MonitoringState, transition: MonitoringTransition): boolean {
    return Boolean(STATE_TRANSITIONS[currentState][transition]);
  }

  static getNextState(currentState: MonitoringState, transition: MonitoringTransition): MonitoringState {
    const nextState = STATE_TRANSITIONS[currentState][transition];
    if (!nextState) {
      throw new Error(`Invalid monitoring transition: ${transition} from ${currentState}`);
    }
    return nextState;
  }

  static availableTransitions(currentState: MonitoringState): MonitoringTransition[] {
    return Object.keys(STATE_TRANSITIONS[currentState]) as MonitoringTransition[];
  }
}

