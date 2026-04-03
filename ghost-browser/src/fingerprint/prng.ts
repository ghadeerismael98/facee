export class SeededPRNG {
  private state: number;

  constructor(seed: number) {
    this.state = seed | 0;
  }

  next(): number {
    // Mulberry32 algorithm
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Random int in [min, max] inclusive */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Pick random element from array */
  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Boolean with given probability (default 0.5) */
  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  /** Random float in [min, max) */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}
