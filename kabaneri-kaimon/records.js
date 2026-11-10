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

function copyData(data) {
 return JSON.parse(JSON.stringify(data));
}

function validationError(data) {
 if (!data || ![data.games, data.bells].every(validCount)) {
  return '通常時G・ベル回数は0〜1,000万の整数で入力してください。';
 }
 if (typeof data.trackingBell !== 'boolean' || (data.bellGames === null && data.trackingBell)) {
  return 'ベルの計測状態を確認してください。';
 }
 if (data.bellGames !== null &&
     (!validCount(data.bellGames) || data.bellGames > data.games)) {
  return 'ベル計測Gは通常時G以下の整数で入力してください。';
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
 const issues = [];
 for (const [key, name] of [['games', '通常時G'], ['bells', '下段ベル']]) {
  const value = saved[key] ?? 0;
  if (validCount(value)) data[key] = value;
  else issues.push(name);
 }
 for (const [key, name] of Object.entries(CHARACTERS)) {
  const source = saved[key];
  const total = source?.total ?? 0, lit = source?.lit ?? 0;
  if ((source == null || (typeof source === 'object' && !Array.isArray(source))) &&
      validCount(total) && validCount(lit) && lit <= total) {
   data[key] = {total, lit};
  } else issues.push(name + 'の発光記録');
 }
 // 旧版の通常時Gのうち実際にベルを数えた範囲は不明。
 return {data, issues};
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
  const before = copyData(after);
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
  const opening = new Promise((resolve, reject) => {
   const request = indexedDB.open(RECORD_DB, 1);
   request.onupgradeneeded = () => request.result.createObjectStore('records');
   request.onerror = () => reject(request.error);
   request.onsuccess = () => {
    const db = request.result;
    db.onclose = () => {
     if (connection === opening) connection = undefined;
    };
    db.onversionchange = () => {
     db.close();
     if (connection === opening) connection = undefined;
    };
    resolve(db);
   };
  }).catch(error => {
   if (connection === opening) connection = undefined;
   throw error;
  });
  connection = opening;
 }
 return connection;
}

async function withTransaction(run) {
 const opening = openRecords();
 const db = await opening;
 let tx;
 try {
  tx = db.transaction('records', 'readwrite');
 } catch (error) {
  if (error.name !== 'InvalidStateError') throw error;
  if (connection === opening) connection = undefined;
  tx = (await openRecords()).transaction('records', 'readwrite');
 }
 return run(tx);
}

function isDamaged(current) {
 return current !== undefined && (!Number.isSafeInteger(current?.revision) ||
  current.revision < 0 || !!validationError(current.data));
}

function recordTransaction(update, recover = false) {
 // 同じストアの書き込みトランザクション内で読み直し、更新の取りこぼしを防ぐ。
 return withTransaction(tx => new Promise((resolve, reject) => {
  const store = tx.objectStore('records');
  let result;
  let failure;
  const request = store.get('current');
  request.onsuccess = () => {
   try {
    const current = request.result;
    const raw = localStorage.getItem(LEGACY_KEY);
    if (isDamaged(current) && !recover) {
     result = {problem: 'damaged', backup: JSON.stringify(current)};
     return;
    }
    const response = update(current, raw);
    result = response.result;
    if (response.backupKey) store.add({record: current, legacyRaw: raw}, response.backupKey);
    if (response.save) store.put(response.save, 'current');
   } catch (error) {
    failure = error;
    tx.abort();
   }
  };
  tx.oncomplete = () => resolve(result);
  tx.onabort = () => reject(failure ?? tx.error ?? new Error('保存できませんでした'));
 }));
}

function readRecords(discardedLegacy) {
 return recordTransaction((current, raw) => {
  if (current) {
   const history = validHistory(current.history);
   const repaired = history.length !== current.history?.length;
   const record = {...current, history};
   return {result: {record, legacyChanged: raw !== current.legacyRaw, repaired}};
  }
  let data = emptyData(), history = [], issues = [];
  if (raw !== null && raw !== discardedLegacy) {
   try {
    const saved = JSON.parse(raw);
    ({data, issues} = legacyData(saved));
    if (!issues.length) history = legacyHistory(saved.history, data);
   } catch {
    return {result: {problem: 'legacy', backup: raw}};
   }
  }
  const record = {revision: 0, data, history, legacyRaw: raw, migrationIssues: issues};
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
  return {result: {record: saved, changed: true}, save: saved};
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

function recoverDamaged(backedUpRecord, backedUpLegacy) {
 return recordTransaction((current, raw) => {
  if (!isDamaged(current)) {
   return {result: current ? {record: current, legacyChanged: raw !== current.legacyRaw} :
    {problem: 'unavailable'}};
  }
  const backup = JSON.stringify(current);
  if (backup !== backedUpRecord || raw !== backedUpLegacy) {
   return {result: {problem: 'damaged', backup}};
  }
  const oldRevision = Number.isSafeInteger(current?.revision) ? current.revision : 0;
  const revision = Math.max(Date.now(), oldRevision + 1);
  const record = {revision, data: emptyData(), history: [], legacyRaw: raw};
  return {result: {record}, save: record, backupKey: 'recovery-' + revision};
 }, true);
}
