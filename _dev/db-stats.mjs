import { DatabaseSync } from 'node:sqlite';
const file = process.argv[2] || 'data/workbench.db';
const db = new DatabaseSync(file, { readOnly: true });
const rows = db.prepare('SELECT id,status,stages,parent_task_id,parent_stage_id FROM task').all();
let nodes = 0; let tops = 0; let subs = 0; let autos = 0; let pairs = 0;
const statuses = {};
for (const r of rows) {
  statuses[r.status] = (statuses[r.status] || 0) + 1;
  let st = [];
  try { st = JSON.parse(r.stages || '[]'); } catch { st = []; }
  nodes += st.length;
  tops += st.filter(s => s && !s.pid).length;
  subs += st.filter(s => s && s.pid).length;
  autos += st.filter(s => s && s.auto).length;
  for (const a of st.filter(s => s && s.auto && s.pid)) {
    const t = st.find(x => x && x.id === a.pid && !x.pid);
    if (t && t.name === a.name && (t.start || t.date) === (a.start || a.date) && (t.end || t.date) === (a.end || a.date)) pairs++;
  }
}
const children = rows.filter(r => r.parent_task_id).length;
console.log(JSON.stringify({
  file: file,
  tasks: rows.length,
  stages: { total: nodes, top: tops, sub: subs, auto: autos },
  children,
  duplicatePairs: pairs,
  statuses
}, null, 2));
