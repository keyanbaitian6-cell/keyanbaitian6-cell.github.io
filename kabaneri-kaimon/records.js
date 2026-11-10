const RECORD_LIMIT = 10_000_000;
const LEGACY_KEY = 'kabaneri-counter-v2';
const RECORD_DB = 'kabaneri-kaimon-v3';
const CHARACTERS = {una: '無名', iko: '生駒', kab: 'カバネ'};
const CZ_CHARACTERS = {una: '無名', iko: '生駒'};
const CZ_BUCKETS = ['1〜50pt', '51〜100pt', '101pt以上'];
const HISTORY_LIMIT = 300;

function emptyData() {
 return {
  games: 0, bellGames: null, bells: 0, trackingBell: false,
  una: {total: 0, lit: 0}, iko: {total: 0, lit: 0}, kab: {total: 0, lit: 0},
  cz: {una: [0, 0, 0], iko: [0, 0, 0]}
 };
}

function validCount(value) {
 return Number.isSafeInteger(value) && value >= 0 && value <= RECORD_LIMIT;
}

function validationError(data) {
 if (!data || ![data.games, data.bells].every(validCount)) {
  return '通常時G・ベル回数は0〜1,000万の整数で入力してください。';
 }
 if (typeof data.trackingBell !== 'boolean' || (data.bellGames === null && data.trackingBell)) {
  return 'ベルの計測状態を確認してください。';
 }
 if (data.bellGames !== null &&
     (!validCount(data.bellGames) || data.bellGames > data.games || data.bells > data.bellGames)) {
  return 'ベル回数 ≦ ベル計測G ≦ 通常時Gになるように入力してください。';
 }
 for (const [key, name] of Object.entries(CHARACTERS)) {
  const value = data[key];
  if (!value || ![value.total, value.lit].every(validCount) || value.lit > value.total) {
   return name + 'の発光回数と単独回数を確認してください。';
  }
 }
 for (const [key, name] of Object.entries(CZ_CHARACTERS)) {
  const counts = data.cz?.[key];
  if (!Array.isArray(counts) || counts.length !== CZ_BUCKETS.length ||
      !CZ_BUCKETS.every((_, i) => validCount(counts[i]))) {
   return name + 'のCZ回数は0〜1,000万の整数で入力してください。';
  }
 }
 return '';
}

function validHistory(entries) {
 if (!Array.isArray(entries)) return [];
 // 不明な操作をまたいで取り消すと、正常な操作まで消えるため、連続した末尾だけを使う。
 const history = [];
 for (const entry of entries.slice(-HISTORY_LIMIT).reverse()) {
  if (typeof entry?.label !== 'string' || validationError(entry.before)) break;
  history.push(entry);
 }
 return history.reverse();
}

function legacyData(saved) {
 if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('invalid legacy data');
 const data = emptyData();
 for (const key of ['games', 'bells']) data[key] = saved[key] ?? 0;
 for (const key of Object.keys(CHARACTERS)) {
  data[key] = {total: saved[key]?.total ?? 0, lit: saved[key]?.lit ?? 0};
 }
 // 旧版の通常時Gのうち実際にベルを数えた範囲は不明。
 if (validationError(data)) throw new Error('invalid legacy counts');
 return data;
}

function legacyHistory(entries, data) {
 const keys = new Set(['games', 'bells', ...Object.keys(CHARACTERS)
  .flatMap(key => [key + '.total', key + '.lit'])]);
 const history = [];
 let after = data;
 for (const entry of (Array.isArray(entries) ? entries.slice(-HISTORY_LIMIT).reverse() : [])) {
  if (typeof entry?.label !== 'string' || !entry.changes ||
      typeof entry.changes !== 'object' || Array.isArray(entry.changes)) break;
  const changes = Object.entries(entry.changes);
  if (!changes.length || changes.some(([key, delta]) => !keys.has(key) || !Number.isSafeInteger(delta))) break;
  const before = structuredClone(after);
  for (const [key, delta] of changes) {
   const [group, field] = key.split('.');
   if (field) before[group][field] -= delta;
   else before[group] -= delta;
  }
  if (validationError(before)) break;
  history.push({label: entry.label, before});
  after = before;
 }
 return history.reverse();
}

let connection;

function openRecords() {
 if (!connection) {
  connection = new Promise((resolve, reject) => {
   const request = indexedDB.open(RECORD_DB, 1);
   request.onupgradeneeded = () => request.result.createObjectStore('records');
   request.onerror = () => reject(request.error);
   request.onsuccess = () => {
    const db = request.result;
    db.onversionchange = () => {
     db.close();
     connection = undefined;
    };
    resolve(db);
   };
  }).catch(error => {
   connection = undefined;
   throw error;
  });
 }
 return connection;
}

async function recordTransaction(update) {
 const db = await openRecords();
 // 同じストアの書き込みトランザクション内で読み直し、更新の取りこぼしを防ぐ。
 return new Promise((resolve, reject) => {
  const tx = db.transaction('records', 'readwrite');
  const store = tx.objectStore('records');
  let result;
  let failure;
  const request = store.get('current');
  request.onsuccess = () => {
   try {
    const current = request.result;
    const raw = localStorage.getItem(LEGACY_KEY);
    if (current && (!Number.isSafeInteger(current.revision) || current.revision < 0 ||
        validationError(current.data))) {
     result = {problem: 'damaged', backup: JSON.stringify(current)};
     return;
    }
    const response = update(current, raw);
    result = response.result;
    if (response.save) store.put(response.save, 'current');
   } catch (error) {
    failure = error;
    tx.abort();
   }
  };
  tx.oncomplete = () => resolve(result);
  tx.onabort = () => reject(failure ?? tx.error ?? new Error('保存できませんでした'));
 });
}

function readRecords(discardedLegacy) {
 return recordTransaction((current, raw) => {
  if (current) {
   const history = validHistory(current.history);
   const repaired = history.length !== current.history?.length;
   const record = {...current, history};
   return {result: {record, legacyChanged: raw !== current.legacyRaw, repaired}};
  }
  let data = emptyData(), history = [];
  if (raw !== null && raw !== discardedLegacy) {
   try {
    const saved = JSON.parse(raw);
    data = legacyData(saved);
    history = legacyHistory(saved.history, data);
   } catch {
    return {result: {problem: 'legacy', backup: raw}};
   }
  }
  const record = {revision: 0, data, history, legacyRaw: raw};
  return {result: {record}, save: record};
 });
}

function writeRecord(action, expectedRevision) {
 return recordTransaction((current, raw) => {
  if (!current) return {result: {problem: 'unavailable'}};
  const record = {...current, history: validHistory(current.history)};
  if (raw !== current.legacyRaw) {
   return {result: {record, legacyChanged: true}};
  }
  if (expectedRevision !== undefined && expectedRevision !== current.revision) {
   return {result: {record, stale: true}};
  }
  const change = action(record);
  if (!change) return {result: {record}};
  if (change.error) return {result: {record, error: change.error}};
  const saved = {...record, ...change, revision: current.revision + 1};
  const error = validationError(saved.data);
  if (error) return {result: {record, error}};
  return {result: {record: saved}, save: saved};
 });
}

function acknowledgeLegacy(backedUpLegacy) {
 return recordTransaction((current, raw) => {
  if (!current) return {result: {problem: 'unavailable'}};
  if (raw !== backedUpLegacy) return {result: {record: current, legacyChanged: true}};
  const record = {...current, history: validHistory(current.history),
   revision: current.revision + 1, legacyRaw: raw};
  return {result: {record}, save: record};
 });
}
