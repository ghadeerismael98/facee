/**
 * Credits / Premium — always unlimited in our standalone system.
 * No external server calls.
 */
import { StorageAdapter } from '../storage/storage';

export async function checkPremiumStatus(_storage: StorageAdapter): Promise<{ isPremium: boolean; expiry: string | null }> {
  return { isPremium: true, expiry: null };
}

export async function getCredits(_storage: StorageAdapter): Promise<number> {
  return 999999;
}

export async function useCredit(_email: string): Promise<boolean> {
  return true;
}

export async function verifyPremium(_email: string): Promise<boolean> {
  return true;
}
