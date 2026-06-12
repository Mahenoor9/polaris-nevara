import { sha256 } from 'js-sha256';
import { randomBytes } from 'crypto';

export function computeTransactionId(data: {
  projectId: string;
  userId: string;
  credits: number;
  timestamp: Date;
}): string {
  const salt = randomBytes(16).toString('hex');
  const input = `${data.projectId}${data.userId}${data.credits}${data.timestamp.toISOString()}${salt}`;
  return sha256(input);
}

export function computeProofHash(fileUrl: string): string {
  return sha256(fileUrl + Date.now().toString());
}

export function computeMerkleRoot(transactionIds: string[]): string {
  if (transactionIds.length === 0) {
    return sha256('empty');
  }

  if (transactionIds.length === 1) {
    return sha256(transactionIds[0]);
  }

  let currentLevel = transactionIds.map(id => sha256(id));

  while (currentLevel.length > 1) {
    const nextLevel: string[] = [];
    
    for (let i = 0; i < currentLevel.length; i += 2) {
      if (i + 1 < currentLevel.length) {
        nextLevel.push(sha256(currentLevel[i] + currentLevel[i + 1]));
      } else {
        nextLevel.push(sha256(currentLevel[i] + currentLevel[i]));
      }
    }
    
    currentLevel = nextLevel;
  }

  return currentLevel[0];
}

export function computeBlockHash(data: {
  index: number;
  timestamp: Date;
  merkleRoot: string;
  previousHash: string;
  transactionCount: number;
}): { hash: string; input: string } {
  const input = `${data.index}${data.timestamp.toISOString()}${data.merkleRoot}${data.previousHash}${data.transactionCount}`;
  return { hash: sha256(input), input };
}

export function generateValidatorSignature(blockHash: string, validatorId: string): string {
  return sha256(blockHash + validatorId + Date.now().toString());
}
