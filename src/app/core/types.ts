export interface PlayerInfo {
  name: string;
  main_job: string;
  main_job_id: number;
  main_job_level: number;
  sub_job: string;
  sub_job_id: number;
  sub_job_level: number;
}

export interface BagItem {
  slot: number;
  id: number;
  count: number;
  status: number;
  equipped: boolean;
  /** /unequip slot name (main, l.ear, …) — set only when equipped */
  equip_slot?: string;
  extdata?: string;
  augments?: Array<string | Record<string, unknown>>;
}

export interface Bag {
  id: number;
  key: string;
  name: string;
  enabled: boolean;
  max: number;
  count: number;
  items: BagItem[];
}

export interface ItemMeta {
  id: number;
  name: string;
  name_log?: string;
  category?: string;
  level?: number;
  ilvl?: number;
  slots?: string[];
  slot_mask?: number;
  jobs?: string[];
  all_jobs?: boolean;
  jobs_mask?: number;
  flags?: number;
  rare?: boolean;
  ex?: boolean;
  stack?: number;
  type?: string | number;
  description?: string;
}

export interface InventoryState {
  timestamp: number;
  player?: PlayerInfo;
  bags: Bag[];
  catalog: Record<string, ItemMeta>;
}

export interface GearswapFileEntry {
  path: string; // relative to the gearswap data dir
  name: string;
  dir: string; // '' = data root, otherwise the player folder
}

export interface GearswapFileList {
  dir: string;
  found: boolean;
  files: GearswapFileEntry[];
}

export interface GearswapFileContent {
  path: string;
  content: string;
}

// ---------- FFXI macro files (USER/<content id>/mcr*.dat) ----------

export interface MacroEntry {
  /** button label, max 8 bytes */
  name: string;
  /** up to 6 command lines, max 60 bytes each; "[AT:xxxxxxxx]" marks an
   *  auto-translate phrase, "\xNN" a raw byte */
  lines: string[];
}

export interface MacroPalette {
  /** file index: mcr.dat = 0, mcrN.dat = N */
  index: number;
  file: string;
  book: number; // 1-40
  palette: number; // 1-10 within the book
  macros: MacroEntry[];
}

export interface MacroCharacter {
  /** content id — the USER/<id> folder name */
  id: string;
  /** book titles 1-40 (from mcr.ttl + mcr_2.ttl) */
  titles: string[];
  /** palettes that exist on disk; missing index = empty palette */
  palettes: MacroPalette[];
}

export interface MacroState {
  /** client is logged in — writes may be overwritten by the client on logout */
  logged_in: boolean;
  characters: MacroCharacter[];
}
