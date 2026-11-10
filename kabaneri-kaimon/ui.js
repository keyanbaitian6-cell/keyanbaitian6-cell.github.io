const $ = selector => document.querySelector(selector);
let state = emptyData(), currentRecord, storageResult = {};
let storageWarning = '記録を読み込んでいます。';
let editRevision, editTracking, toastTimer, channel;
let queued = Promise.resolve(), queuedCount = 0, queuedRevision;
const owns = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
try {
 channel = new BroadcastChannel('kabaneri-kaimon-records');
 channel.onmessage = () => refreshRecords();
} catch {
 // 画面へ戻ったときにも更新を取得する。
}

function percent(rate) {
 const value = rate * 100;
 if (value > 0 && value < .1) return '0.1%未満';
 if (value > 99.9) return '99.9%超';
 return value.toFixed(1) + '%';
}
function toast(message) {
 $('#toast').textContent = message;
 $('#toast').classList.add('show');
 clearTimeout(toastTimer);
 toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 2500);
}
function acceptResult(result) {
 if (result.record && (!currentRecord || result.record.revision >= currentRecord.revision)) {
  currentRecord = result.record;
  state = result.record.data;
 }
 storageResult = result;
 storageWarning = '';
 if (result.problem) storageWarning = '保存記録を確認できません。控えを保存して確認してください。';
 else if (result.legacyChanged) storageWarning = '旧版でも記録が変更されています。控えを保存し、旧版のタブを閉じて再開してください。';
 else if (result.repaired) storageWarning = '一部の履歴を読み込めませんでした。正常な末尾の操作だけ取り消せます。';
 else if (result.record?.migrationIssues?.length) {
  storageWarning = '旧記録のうち ' + result.record.migrationIssues.join('・') +
   ' は数値を確認できませんでした。他の回数を引き継ぎ、元の記録は控えから確認できます。';
 }
 if (result.stale) toast('記録が更新されました。最新の記録を確認して操作し直してください。');
 if (result.error) toast(result.error);
 render();
}
function storageFailure() {
 storageWarning = '保存に失敗しました。もう一度操作すると接続を確認します。復帰しない場合は控えを保存し、ページを読み込み直してください。';
 storageResult = {problem: 'io'};
 render();
}
async function refreshRecords() {
 try { acceptResult(await readRecords()); } catch { storageFailure(); }
}
async function ensureWritable() {
 if (!currentRecord || storageResult.problem === 'io') await refreshRecords();
 if (currentRecord && !storageResult.problem && !storageResult.legacyChanged) return true;
 toast('保存状態を確認してから操作してください。');
 return false;
}
function enqueueOperation(operation) {
 if (!queuedCount) queuedRevision = currentRecord?.revision;
 queuedCount++;
 queued = queued.then(async () => {
  if (!await ensureWritable()) return;
  queuedRevision ??= currentRecord.revision;
  await operation();
 }).catch(storageFailure).finally(() => queuedCount--);
}
async function mutate(action, revision) {
 try {
  const result = await writeRecord(action, revision);
  acceptResult(result);
  if (result.problem || result.legacyChanged || result.stale || result.error) return false;
  // 他タブの更新が間に入った場合は、取り消しなどの確認対象を進めない。
  if (queuedCount && result.changed && result.record.revision === queuedRevision + 1) queuedRevision++;
  channel?.postMessage('changed');
  return true;
 } catch {
  storageFailure();
  return false;
 }
}
function appendOperation(saved, label, data) {
 return {data, history: [...saved.history, {label, before: saved.data}].slice(-HISTORY_LIMIT)};
}
function record(label, update) {
 return mutate(saved => {
  const next = copyData(saved.data);
  update(next);
  return appendOperation(saved, label, next);
 });
}

function renderAnalysis() {
 const r = analyze(state);
 if (r.empty) {
  $('#analysis').innerHTML = '<div class="analysis-top">計測した記録を入れると分析します</div>';
 } else {
  const title = r.winners.length === 6 ? '設定間の差はありません' :
   r.logRatio < Math.log(1.25) ? '候補が拮抗しています' :
    'この仮定で最も近い候補は設定' + (r.ranked[0] + 1);
  const ratio = r.logRatio > Math.log(1000000) ? '100万倍超' : Math.exp(r.logRatio).toFixed(2) + '倍';
  const sample = (r.hasBell ? 'ベル ' + state.bells + '回 / ' + state.bellGames + 'G' : 'ベル 未計測') +
   '　' + Object.keys(CHARACTERS).map(key => CHARACTERS[key] + ' ' + state[key].lit +
    '/' + state[key].total + '回').join('　');
  $('#analysis').innerHTML = '<div class="analysis-top">' + title + '</div>' +
   '<p class="analysis-meta">上位2候補の支持比は' + ratio +
   'です。1.25倍未満は拮抗と表示します。この境界は表示上の目安です。</p>' +
   '<p class="analysis-meta">' + sample + '</p>' +
   '<div class="ranking">' + r.ranked.map(i => '<div class="rank-row ' +
    (r.winners.includes(i) ? 'top' : '') + '"><span>設定' + (i + 1) +
    '</span><div class="progress"><i style="width:' + (r.weights[i] * 100) +
    '%"></i></div><strong>' + percent(r.weights[i]) + '</strong></div>').join('') + '</div>' +
   '<p class="foot">相対支持度は採用した6モデル内の比較です。少ない記録でも順位は出ます。実際の設定確率や的中率はわかりません。</p>' +
   '<div class="data-scroll" tabindex="0" role="region" aria-label="要素別の比較"><table class="model-table">' +
   '<caption>要素別の比較（各列合計100%）</caption><thead><tr><th>候補</th><th>ベルのみ</th><th>発光のみ</th><th>統合</th></tr></thead><tbody>' +
   r.ranked.map(i => '<tr><th>設定' + (i + 1) + '</th><td>' +
    (r.hasBell ? percent(r.bellWeights[i]) : '未計測') + '</td><td>' +
    (r.hasLight ? percent(r.lightWeights[i]) : '未計測') + '</td><td>' +
    percent(r.weights[i]) + '</td></tr>').join('') + '</tbody></table></div>';
 }
 renderSensitivity();
}
function renderSensitivity() {
 if (!state.una.total && !state.iko.total) {
  $('#sensitivity').textContent = '無名・生駒を記録すると比較します。';
  return;
 }
 const oldLogs = [0, 0, 3].map(group => ['una', 'iko'].reduce((sum, key) => {
  const [hits, total] = REFERENCE[key][group];
  return sum + logBinomial(state[key].total, state[key].lit, hits / total);
 }, 0));
 const newLogs = [[.12, .11], [.14, .13], [.24, .18]].map(rates =>
  ['una', 'iko'].reduce((sum, key, i) =>
   sum + logBinomial(state[key].total, state[key].lit, rates[i]), 0));
 const oldWeights = normalize(oldLogs), newWeights = normalize(newLogs);
 $('#sensitivity').innerHTML = '<table class="model-table cz-table"><caption>発光のみ・3候補内の参考比較</caption>' +
  '<thead><tr><th>仮の候補</th><th>件数表の率を固定</th><th>追加資料の率を固定</th></tr></thead><tbody>' +
  [1, 2, 6].map((setting, i) => '<tr><th>設定' + setting + '</th><td>' +
   percent(oldWeights[i]) + '</td><td>' + percent(newWeights[i]) + '</td></tr>').join('') +
  '</tbody></table><p class="foot">件数表では設定1・2を同じ「推定低設定」の率で比較しています。</p>';
}
function renderCz() {
 const columns = [state.cz.una, state.cz.iko,
  state.cz.una.map((value, i) => value + state.cz.iko[i])];
 function cell(counts, hits) {
  const total = counts.reduce((a, b) => a + b, 0);
  return '<td>' + (total ? (hits * 100 / total).toFixed(1) + '%' : '—') +
   '<small>' + hits + '/' + total + '件</small></td>';
 }
 $('#czResults').innerHTML = '<table class="model-table cz-table"><caption>実戦の当選割合</caption>' +
  '<thead><tr><th>区分</th><th>無名</th><th>生駒</th><th>合算</th></tr></thead><tbody>' +
  CZ_BUCKETS.map((label, i) => '<tr><th>' + label + '</th>' +
   columns.map(counts => cell(counts, counts[i])).join('') + '</tr>').join('') +
  '<tr><th>100pt以内</th>' + columns.map(counts => cell(counts, counts[0] + counts[1])).join('') +
  '</tr></tbody></table>';
}
function render() {
 $('#games').textContent = state.games;
 $('#bells').textContent = state.bells;
 if (state.bellGames === null) {
  $('#bellRate').textContent = state.bells ?
   'ベル計測Gは未確認です。全ゲームで数えた場合は、数値の直接入力で通常時Gと同じ値を入力してください。' : 'ベル未計測';
 } else if (state.bells > state.bellGames) {
  $('#bellRate').textContent = 'ベル計測 ' + state.bellGames + 'G・' + state.bells +
   '回。計測したGを追加するとベルの分析を再開します。';
 } else {
  $('#bellRate').textContent = 'ベル計測 ' + state.bellGames + 'G・' + state.bells + '回' +
   (state.bellGames ? '　' + (state.bells ? '1/' + (state.bellGames / state.bells).toFixed(1) : '未出現') : '');
 }
 $('#trackBell').textContent = state.trackingBell ? 'ベル計測を一時停止' :
  state.bellGames === null ? 'ベル計測を開始' : 'ベル計測を再開';
 $('[data-action="bell"]').disabled = !state.trackingBell || !currentRecord;
 for (const key of Object.keys(CHARACTERS)) {
  const value = state[key];
  $('#' + key + 'Total').textContent = value.total;
  $('#' + key + 'Lit').textContent = value.lit;
  $('#' + key + 'Rate').textContent = value.total ? percent(value.lit / value.total) : '—';
  $('#' + key + 'Progress').style.width = (value.total ? 100 * value.lit / value.total : 0) + '%';
 }
 const history = currentRecord?.history ?? [];
 $('#undoLabel').textContent = history.length ? '直前の操作 ' + history[history.length - 1].label : '記録はこのブラウザーに保存されます。';
 $('#undo').disabled = !history.length;
 $('#storageStatus').textContent = storageWarning;
 $('#backupRecords').hidden = !currentRecord && !storageResult.backup;
 $('#recoverRecords').hidden = !storageResult.legacyChanged && !['legacy', 'damaged'].includes(storageResult.problem);
 $('#recoverRecords').textContent = storageResult.legacyChanged ?
  '控えを確認して現在の記録で再開' : '読めない記録を保管して新しく始める';
 renderAnalysis();
 renderCz();
}

$('#characters').innerHTML = Object.entries(CHARACTERS).map(([key, name]) =>
 '<div class="character"><div><div class="char-name">' + name +
 '</div><div class="char-stats">単独 <strong id="' + key + 'Total"></strong> 回　発光 <strong id="' +
 key + 'Lit"></strong> 回　発光率 <strong id="' + key + 'Rate"></strong></div>' +
 '<div class="progress"><i id="' + key + 'Progress"></i></div></div>' +
 '<div class="char-buttons"><button class="btn pink" data-action="lit-' + key + '" aria-label="' + name +
 ' 発光ありを1回追加">発光あり ＋1</button><button class="btn" data-action="dark-' + key +
 '" aria-label="' + name + ' 発光なしを1回追加">発光なし ＋1</button></div></div>').join('');
$('#czButtons').innerHTML = Object.entries(CZ_CHARACTERS).map(([key, name]) =>
 '<div role="group" aria-label="' + name + 'のCZ"><strong>' + name +
 '</strong><div class="buttons cz-buttons">' + CZ_BUCKETS.map((label, i) =>
 '<button class="btn cyan" data-action="cz-' + key + '-' + i + '" aria-label="' + name + ' CZ ' +
 label + 'を1件追加">' + label + ' ＋1</button>').join('') + '</div></div>').join('');

document.addEventListener('click', event => {
 const button = event.target.closest('[data-action]');
 if (!button) return;
 const action = button.dataset.action;
 enqueueOperation(() => applyCounterAction(action));
});
async function applyCounterAction(action) {
 const [kind, key, bucket] = action.split('-');
 if (kind === 'cz' && owns(CZ_CHARACTERS, key) && /^[012]$/.test(bucket)) {
  await record(CZ_CHARACTERS[key] + ' CZ ' + CZ_BUCKETS[Number(bucket)], next => next.cz[key][bucket]++);
 } else if (action === 'track-bell') {
  if (state.bellGames === null && state.bells > 0) {
   toast('既存のベル回数と計測Gを「数値を直接入力」で確認してください。');
   return;
  }
  await mutate(saved => appendOperation(saved, 'ベルの計測状態を変更',
   {...saved.data, trackingBell: !saved.data.trackingBell, bellGames: saved.data.bellGames ?? 0}),
  queuedRevision);
 } else if (action === 'game1' || action === 'game10') {
  const delta = action === 'game1' ? 1 : 10, tracking = state.trackingBell;
  await mutate(saved => {
   if (saved.data.trackingBell !== tracking) return {error: '別の画面で計測状態が変わりました。確認してからGを追加してください。'};
   return appendOperation(saved, 'ゲーム数 +' + delta,
    {...saved.data, games: saved.data.games + delta,
     bellGames: tracking ? saved.data.bellGames + delta : saved.data.bellGames});
  });
 } else if (action === 'bell') {
  await mutate(saved => saved.data.trackingBell ?
   appendOperation(saved, '下段ベル +1', {...saved.data, bells: saved.data.bells + 1}) :
    {error: 'ベル計測を再開してから追加してください。'});
 } else if (['lit', 'dark'].includes(kind) && owns(CHARACTERS, key)) {
  await record(CHARACTERS[key] + (kind === 'lit' ? ' 発光あり' : ' 発光なし'), next => {
   next[key].total++;
   if (kind === 'lit') next[key].lit++;
  });
 }
}
$('#undo').addEventListener('click', () => {
 enqueueOperation(() => mutate(saved => {
  const last = saved.history[saved.history.length - 1];
  return last ? {data: last.before, history: saved.history.slice(0, -1)} : undefined;
 }, queuedRevision));
});
$('#reset').addEventListener('click', () => {
 if (!currentRecord || !confirm('ベル・発光・CZの記録と取り消し履歴をすべて消します。よろしいですか？')) return;
 const revision = currentRecord.revision;
 enqueueOperation(() => mutate(() => ({data: emptyData(), history: [], migrationIssues: []}), revision));
});

const dialog = $('#editDialog'), form = $('#editForm');
const fields = {games: 'games', bells: 'bells', unaTotal: 'una.total', unaLit: 'una.lit',
 ikoTotal: 'iko.total', ikoLit: 'iko.lit', kabTotal: 'kab.total', kabLit: 'kab.lit'};
$('#editCzFields').innerHTML = Object.entries(CZ_CHARACTERS).map(([key, name]) =>
 '<fieldset><legend>' + name + 'のCZ</legend><div class="edit-grid">' +
 CZ_BUCKETS.map((label, i) => '<label>' + label + '<input name="cz' + key + i +
 '" type="number" inputmode="numeric" min="0" max="10000000" step="1" required></label>').join('') +
 '</div></fieldset>').join('');
async function openEditor(czFocus) {
 if (!await ensureWritable()) return;
 editRevision = currentRecord.revision;
 editTracking = state.trackingBell;
 for (const [name, path] of Object.entries(fields)) {
  const [group, field] = path.split('.');
  form.elements.namedItem(name).value = field ? state[group][field] : state[group];
 }
 form.elements.namedItem('bellGames').value = state.bellGames ?? '';
 for (const key of Object.keys(CZ_CHARACTERS)) {
  CZ_BUCKETS.forEach((_, i) => form.elements.namedItem('cz' + key + i).value = state.cz[key][i]);
 }
 $('#editError').textContent = '';
 dialog.showModal();
 form.elements.namedItem(czFocus ? 'czuna0' : 'games').focus();
}
$('#editCounts').addEventListener('click', () => openEditor(false));
$('#editCzCounts').addEventListener('click', () => openEditor(true));
$('#cancelEdit').addEventListener('click', () => dialog.close());
form.addEventListener('submit', async event => {
 event.preventDefault();
 const next = emptyData();
 for (const [name, path] of Object.entries(fields)) {
  const value = Number(form.elements.namedItem(name).value), [group, field] = path.split('.');
  if (field) next[group][field] = value;
  else next[group] = value;
 }
 const bellInput = form.elements.namedItem('bellGames').value.trim();
 next.bellGames = bellInput === '' ? null : Number(bellInput);
 next.trackingBell = next.bellGames !== null && editTracking;
 for (const key of Object.keys(CZ_CHARACTERS)) {
  next.cz[key] = CZ_BUCKETS.map((_, i) => Number(form.elements.namedItem('cz' + key + i).value));
 }
 const error = validationError(next);
 if (error) { $('#editError').textContent = error; return; }
 if (!await ensureWritable()) { $('#editError').textContent = '保存状態を確認してください。'; return; }
 const success = await mutate(saved => appendOperation(saved, '数値を直接入力', next), editRevision);
 if (success) dialog.close();
 else $('#editError').textContent = '保存できませんでした。最新の記録を確認して開き直してください。';
});
function downloadBackup() {
 const raw = localStorage.getItem(LEGACY_KEY);
 const blob = new Blob([JSON.stringify({savedAt: new Date().toISOString(), record: currentRecord,
  legacyRaw: raw, unreadable: storageResult.backup ?? null}, null, 2)], {type: 'application/json'});
 const url = URL.createObjectURL(blob), link = document.createElement('a');
 link.href = url;
 link.download = 'kabaneri-records-' + Date.now() + '.json';
 document.body.appendChild(link);
 link.click();
 link.remove();
 setTimeout(() => URL.revokeObjectURL(url), 60_000);
 return raw;
}
$('#backupRecords').addEventListener('click', () => {
 try { downloadBackup(); } catch { toast('控えを保存できませんでした。'); }
});
$('#recoverRecords').addEventListener('click', async () => {
 const recovery = storageResult;
 const message = recovery.legacyChanged ?
  '旧記録の控えを保存します。旧版のタブを閉じ、現在の記録で再開しますか？' :
  '読めない記録を保管し、空の記録で新しく始めますか？';
 if (!confirm(message)) return;
 try {
  const raw = downloadBackup();
  if (recovery.legacyChanged) acceptResult(await acknowledgeLegacy(raw));
  else if (recovery.problem === 'damaged') acceptResult(await recoverDamaged(recovery.backup, raw));
  else acceptResult(await readRecords(raw));
  channel?.postMessage('changed');
 } catch { storageFailure(); }
});
window.addEventListener('focus', () => refreshRecords());
window.addEventListener('storage', event => {
 if (event.key === LEGACY_KEY || event.key === null) refreshRecords();
});
document.addEventListener('visibilitychange', () => {
 if (!document.hidden) refreshRecords();
});
render();
refreshRecords();
