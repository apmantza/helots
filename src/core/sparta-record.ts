import * as fs from 'fs';
import * as path from 'path';

export interface SpartaRecord {
  totalBattles: number;
  victories: number;
  defeats: number;
  wondersBuilt: number;
  citiesLost: number;
  currentStreak: number;
  greatGenerals: number;
  lastUpdated: string;
}

export type SpartaEvent = 'BATTLE_WON' | 'BATTLE_LOST' | 'WONDER_BUILT' | 'CITY_LOST' | 'GREAT_GENERAL';

const DEFAULT_RECORD: SpartaRecord = {
  totalBattles: 0,
  victories: 0,
  defeats: 0,
  wondersBuilt: 0,
  citiesLost: 0,
  currentStreak: 0,
  greatGenerals: 0,
  lastUpdated: new Date().toISOString(),
};

export class SpartaRecordManager {
  private record: SpartaRecord = { ...DEFAULT_RECORD };
  private filePath: string = '';

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'sparta-record.json');
    this.record = this.load();
  }

  private load(): SpartaRecord {
    try {
      if (fs.existsSync(this.filePath)) {
        return { ...DEFAULT_RECORD, ...JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) };
      }
    } catch { }
    return { ...DEFAULT_RECORD };
  }

  getRecord(): SpartaRecord {
    return { ...this.record };
  }

  recordRunEnd(passed: number, failed: number, allFirstTry: boolean): SpartaEvent[] {
    const triggered: SpartaEvent[] = [];
    this.record.totalBattles++;
    this.record.lastUpdated = new Date().toISOString();

    if (failed === 0 && passed > 0) {
      this.record.victories++;
      this.record.currentStreak = this.record.currentStreak > 0 ? this.record.currentStreak + 1 : 1;
      triggered.push('BATTLE_WON');

      if (this.record.currentStreak === 5) {
        this.record.wondersBuilt++;
        triggered.push('WONDER_BUILT');
      }
    } else if (passed === 0) {
      this.record.defeats++;
      this.record.currentStreak = this.record.currentStreak < 0 ? this.record.currentStreak - 1 : -1;
      triggered.push('BATTLE_LOST');

      if (this.record.currentStreak === -3) {
        this.record.citiesLost++;
        triggered.push('CITY_LOST');
      }
    } else {
      this.record.currentStreak = 0;
      triggered.push('BATTLE_WON');
    }

    if (allFirstTry) {
      this.record.greatGenerals++;
      triggered.push('GREAT_GENERAL');
    }

    this.save();
    return triggered;
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.record, null, 2), 'utf-8');
    } catch { }
  }
}