/* 临时探针：验证上级派活 → 下属规划承接 → 上级还能不能看见进展
   跑完自行清理，不留数据。 */
const BASE = 'http://localhost:8788';
const MGR = '1012', SUB = '1002';
const SRC = 't_probe_src', NEW = 't_probe_new';

const j = async (p, opt) => (await fetch(BASE + p, opt)).json();
const state = (me) => j('/api/state?me=' + me);
const sync = (me, body) => j('/api/sync', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ me, ...body })
});
const has = (st, id) => st.tasks.some((t) => t.id === id);

// 0 清掉上次残留
await sync(MGR, { del: { tasks: [SRC] } });
await sync(SUB, { del: { tasks: [NEW, SRC] } });

// 1 上级下派
await sync(MGR, {
  tasks: [{
    id: SRC, ownerNo: MGR, assigneeNo: SUB, type: 'assign',
    title: '【探针】季度复盘材料', start: '2026-11-03', end: '2026-11-06',
    status: 'todo', intakeStatus: 'pending'
  }]
});
const mgr1 = await state(MGR), sub1 = await state(SUB);
console.log('① 上级刚下派');
console.log('   上级看得见这条任务        :', has(mgr1, SRC));
const subSrc = sub1.tasks.find((t) => t.id === SRC) || {};
console.log('   下属承接台按 intakeStatus 收进来 :', subSrc.intakeStatus, '(前端 buildIntake 筛 pending)');

// 2 下属「规划并承接」：自己名下新建一条，指回原任务；原任务标已接收
await sync(SUB, {
  tasks: [
    {
      id: NEW, ownerNo: SUB, assigneeNo: SUB, type: 'special',
      title: '【探针】季度复盘材料 · 我的拆解', start: '2026-11-03', end: '2026-11-06',
      status: 'doing', sourceId: SRC, stages: [{ name: '收数', done: true }, { name: '写初稿', done: false }]
    },
    { id: SRC, ownerNo: MGR, assigneeNo: SUB, type: 'assign', title: '【探针】季度复盘材料',
      start: '2026-11-03', end: '2026-11-06', status: 'todo', intakeStatus: 'accepted' }
  ]
});

const mgr2 = await state(MGR), sub2 = await state(SUB);
const srcRow = mgr2.tasks.find((t) => t.id === SRC);
console.log('\n② 下属承接并推进到「进行中」之后');
console.log('   下属自己看得见新任务      :', has(sub2, NEW), '(进度阶段:', (sub2.tasks.find((t) => t.id === NEW) || {}).stages?.length, '个)');
const newRow = mgr2.tasks.find((t) => t.id === NEW) || {};
console.log('   上级看得见新任务          :', has(mgr2, NEW), has(mgr2, NEW) ? '' : '  ← 断在这里');
console.log('   上级看得见原任务          :', !!srcRow);
console.log('   原任务在上级眼里的状态    :', srcRow ? srcRow.intakeStatus : '—');
console.log('   上级能看到的承接任务进度  :', has(mgr2, NEW)
  ? `${newRow.title || ''} · ${newRow.status} · 阶段 ${(newRow.stages || []).filter((s) => s.done).length}/${(newRow.stages || []).length} · 归属 ${newRow.ownerNo}`
  : '无（只停在「已接收」）');
console.log('   上级能改这条任务吗        :', newRow.ownerNo === MGR ? '是' : '否（只读，符合预期）');

// 3 清理
await sync(MGR, { del: { tasks: [SRC] } });
await sync(SUB, { del: { tasks: [NEW, SRC] } });
const after = await state(MGR);
console.log('\n③ 已清理：上级侧残留', after.tasks.filter((t) => t.id === SRC || t.id === NEW).length, '条');
