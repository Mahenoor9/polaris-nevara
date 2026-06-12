import fs from "fs";
import path from "path";
import crypto from "crypto";

export const EVIDENCE_BASE_DIR = process.env.EVIDENCE_BASE_DIR
  ? path.resolve(process.env.EVIDENCE_BASE_DIR)
  : path.resolve(process.cwd(), "evidence");

export function getEvidenceRunDir(projectId: string, runId: string): string {
  return path.join(EVIDENCE_BASE_DIR, projectId, runId);
}

export async function ensureEvidenceDir(projectId: string, runId: string): Promise<string> {
  const dir = getEvidenceRunDir(projectId, runId);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

export async function writeJsonFile(dir: string, filename: string, data: unknown): Promise<string> {
  const filePath = path.join(dir, filename);
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  return filePath;
}

export async function readJsonFile<T>(dir: string, filename: string): Promise<T | null> {
  const filePath = path.join(dir, filename);
  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

export async function fileChecksum(filePath: string): Promise<string> {
  try {
    const content = await fs.promises.readFile(filePath);
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch {
    return "";
  }
}

export async function fileSize(filePath: string): Promise<number> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

export async function listRunIds(projectId: string): Promise<string[]> {
  const projectDir = path.join(EVIDENCE_BASE_DIR, projectId);
  try {
    const entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
