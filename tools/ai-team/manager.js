#!/usr/bin/env node
// <repo-root>/ai-team/manager.js (path จริงตามที่ clone)
// ============================================================
// 🤖 AI Team Manager — Orchestrator
//   อ่าน state.json → เลือก task → สั่ง AI ที่เหมาะสม → บันทึก state
//   ใช้: node manager.js <command> [args]
//
// Commands:
//   status                    - แสดงสถานะทุก task
//   new "<description>"       - สร้าง task ใหม่
//   resume                    - ทำงานต่อจากที่ค้างไว้
//   next                      - ทำ task ถัดไป
//   show <task-id>            - แสดงรายละเอียด task
//   approve-merge <PR#>       - บันทึกว่า owner อนุมัติ merge PR
//   cancel <task-id>          - ยกเลิก task
//   list-branches             - แสดง branch ทั้งหมดใน repo
// ============================================================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 🆕 (T063): ใช้ __dirname แทน absolute path ที่ hard-code — ให้ CLI รันได้จากทุกเครื่อง/ทุกโฟลเดอร์ที่ clone repo
const AI_TEAM_DIR = __dirname;
const STATE_FILE = path.join(AI_TEAM_DIR, 'state.json');
const TASKS_DIR = path.join(AI_TEAM_DIR, 'tasks');
const LOGS_DIR = path.join(AI_TEAM_DIR, 'logs');
const TEAM_FILE = path.join(AI_TEAM_DIR, 'team.json');
const MIUSIC_DIR = path.resolve(AI_TEAM_DIR, '..');

// ============ Utilities ============

function loadState() {
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function saveState(state) {
  state.last_updated = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadTeam() {
  return JSON.parse(fs.readFileSync(TEAM_FILE, 'utf8'));
}

function nextTaskId(state) {
  const all = [
    ...state.tasks.active,
    ...state.tasks.pending_user_approval,
    ...state.tasks.completed,
    ...state.tasks.blocked
  ];
  let max = 0;
  all.forEach(t => {
    // 🆕 (T063-QA fix B4): completed อาจเป็น object {id,...} ตั้งแต่ state v2 — เรียก .match บน object แล้ว crash
    const id = typeof t === 'string' ? t : (t && t.id) || '';
    const m = id.match(/^T(\d+)/);
    if (m) max = Math.max(max, parseInt(m[1]));
  });
  // also check task files
  if (fs.existsSync(TASKS_DIR)) {
    fs.readdirSync(TASKS_DIR).forEach(f => {
      const m = f.match(/^T(\d+)-/);
      if (m) max = Math.max(max, parseInt(m[1]));
    });
  }
  return `T${String(max + 1).padStart(3, '0')}`;
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40);
}

function createTaskFile(taskId, title, description, branch) {
  const slug = slugify(title);
  const filename = `${taskId}-${slug}.json`;
  const filepath = path.join(TASKS_DIR, filename);
  const now = new Date().toISOString();
  const task = {
    id: taskId,
    title,
    description,
    created_at: now,
    updated_at: now,
    status: 'intake',
    current_stage: 1,
    branch,
    // 🆕 (T063): template ตาม workflow v3 — 13 ขั้น (code_review อยู่หน้า qa ตามกฎเหล็กข้อ 7)
    stages: {
      intake: { started_at: now, completed_at: null, result: null },
      scan: { started_at: null, completed_at: null, scanned_files: [], unknowns: [] },
      plan: { started_at: null, completed_at: null, plan: null, files_to_change: [], acceptance_criteria: [] },
      develop: { started_at: null, completed_at: null, commits: [], files_changed: [] },
      self_review: { started_at: null, completed_at: null, checklist: null },
      code_review: { started_at: null, completed_at: null, review_result: null, files_reviewed: 0 },
      qa: { started_at: null, completed_at: null, test_results: null, bugs_found: [] },
      fix: { started_at: null, completed_at: null, commits: [], files_changed: [] },
      qa_again: { started_at: null, completed_at: null, test_results: null },
      security_final: { started_at: null, completed_at: null, audit_result: null, iron_rules_check: null },
      pr: { started_at: null, pr_number: null, pr_url: null, merged_at: null },
      owner_approval: { started_at: null, completed_at: null, approved_by: null },
      production: { started_at: null, completed_at: null, deploy_version: null, rollback_plan: null }
    },
    blockers: [],
    decisions: [],
    log_file: path.join(LOGS_DIR, `${taskId}-${slug}.log`)
  };
  fs.writeFileSync(filepath, JSON.stringify(task, null, 2));
  // 🆕 (T063-code review fix): logs/ ไม่มีบน clone สด → writeFileSync log จะ crash — สร้างก่อนเสมอ
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  // create empty log file
  fs.writeFileSync(task.log_file, `# Log: ${taskId} — ${title}\n\nCreated: ${now}\n\n`);
  return task;
}

function loadTask(taskId) {
  if (!fs.existsSync(TASKS_DIR)) return null;
  for (const f of fs.readdirSync(TASKS_DIR)) {
    if (f.startsWith(taskId + '-')) {
      return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8'));
    }
  }
  return null;
}

function saveTask(task) {
  task.updated_at = new Date().toISOString();
  const slug = slugify(task.title);
  const filename = `${task.id}-${slug}.json`;
  fs.writeFileSync(path.join(TASKS_DIR, filename), JSON.stringify(task, null, 2));
}

function appendTaskLog(task, message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(task.log_file, line);
}

function git(args, cwd = MIUSIC_DIR) {
  try {
    return execSync(`git ${args}`, { cwd, encoding: 'utf8' }).trim();
  } catch (err) {
    return `ERROR: ${err.message}`;
  }
}

// ============ Commands ============

function cmdStatus() {
  const state = loadState();
  const team = loadTeam();
  console.log('='.repeat(70));
  console.log('🤖 AI Team Status — Miusic Project');
  console.log('='.repeat(70));
  console.log(`Last updated: ${state.last_updated}`);
  console.log('');
  console.log('📋 Project:');
  console.log(`   GitHub: ${state.github.repo}`);
  console.log(`   Cloudflare Worker: ${state.cloudflare.worker_name}`);
  console.log(`   Production URL: ${state.cloudflare.production_url}`);
  console.log('');
  console.log('👥 Team members:');
  team.members.forEach(m => {
    console.log(`   ${m.id.padEnd(10)} — ${m.name} (${m.role})`);
  });
  console.log('');
  console.log('📦 Tasks:');
  console.log(`   Active:               ${state.tasks.active.length}`);
  console.log(`   Pending user approval: ${state.tasks.pending_user_approval.length}`);
  console.log(`   Completed:            ${state.tasks.completed.length}`);
  console.log(`   Blocked:              ${state.tasks.blocked.length}`);
  console.log('');
  if (state.tasks.active.length > 0) {
    console.log('🔄 Active tasks:');
    state.tasks.active.forEach(t => {
      const task = loadTask(t);
      if (task) {
        console.log(`   ${t} — ${task.title}`);
        console.log(`        stage: ${task.status || '—'} (stage ${task.current_stage || '?'}/13)`);
        console.log(`        branch: ${task.branch}`);
      }
    });
    console.log('');
  }
  if (state.tasks.pending_user_approval.length > 0) {
    console.log('⏸️  Pending user approval:');
    state.tasks.pending_user_approval.forEach(t => {
      const task = loadTask(t);
      if (task) {
        console.log(`   ${t} — ${task.title}`);
        if (task.stages.pr && task.stages.pr.pr_url) console.log(`        PR: ${task.stages.pr.pr_url}`);
      }
    });
    console.log('');
  }
  if (state.github.open_prs.length > 0) {
    console.log('🔗 Open PRs:');
    state.github.open_prs.forEach(pr => {
      console.log(`   PR #${pr.number}: ${pr.title}`);
      console.log(`        ${pr.url}`);
      console.log(`        status: ${pr.status}`);
    });
    console.log('');
  }
  console.log('='.repeat(70));
  console.log('💡 บอก AI: "resume ai-team" เพื่อทำงานต่อ');
  console.log('='.repeat(70));
}

function cmdNew(description) {
  if (!description) {
    console.error('ERROR: ต้องระบุ description');
    process.exit(1);
  }
  const state = loadState();
  const taskId = nextTaskId(state);
  // สร้าง short title จาก description
  let title = description.slice(0, 60);
  if (description.length > 60) title = description.slice(0, 57) + '...';
  const slug = slugify(title);
  const branch = `ai-team/${taskId}-${slug}`;
  const task = createTaskFile(taskId, title, description, branch);
  // อัปเดต state
  state.tasks.active.push(taskId);
  saveState(state);
  console.log(`✅ Created task ${taskId}`);
  console.log(`   Title: ${title}`);
  console.log(`   Branch: ${branch}`);
  console.log(`   Task file: ${path.join(TASKS_DIR, `${taskId}-${slug}.json`)}`);
  console.log('');
  console.log('💡 AI Manager จะเริ่มทำงานที่ stage 1 (intake) → stage 2 (scan)');
  console.log('   บอก AI: "next" เพื่อเริ่มทำ task นี้');
}

function cmdResume() {
  const state = loadState();
  if (state.tasks.active.length === 0) {
    console.log('✅ ไม่มี task ที่ค้างไว้ — พร้อมรับ task ใหม่');
    return;
  }
  console.log(`🔄 พบ ${state.tasks.active.length} task ที่ค้างไว้:`);
  state.tasks.active.forEach(t => {
    const task = loadTask(t);
    if (task) {
      console.log(`   ${t} — ${task.title} (stage ${task.current_stage || '?'}/13: ${task.status || '—'})`);
    }
  });
  console.log('');
  console.log('💡 บอก AI: "next" เพื่อทำ task ถัดไป');
}

function cmdShow(taskId) {
  const task = loadTask(taskId);
  if (!task) {
    console.error(`ERROR: ไม่พบ task ${taskId}`);
    process.exit(1);
  }
  console.log('='.repeat(70));
  console.log(`📋 Task ${task.id}: ${task.title}`);
  console.log('='.repeat(70));
  console.log(`Description: ${task.description}`);
  console.log(`Branch: ${task.branch}`);
  console.log(`Status: ${task.status || '—'} (stage ${task.current_stage || '?'}/13)`);
  console.log(`Created: ${task.created_at}`);
  console.log(`Updated: ${task.updated_at}`);
  console.log('');
  console.log('Stages:');
  // 🆕 (T063): 13 ขั้นตาม team.json workflow_stages v3
  const stages = ['intake', 'scan', 'plan', 'develop', 'self_review', 'code_review', 'qa', 'fix', 'qa_again', 'security_final', 'pr', 'owner_approval', 'production'];
  // 🆕 (T063-QA fix B1): task file บางไฟล์ (เก่า + ใหม่) ไม่มี stages/blockers/decisions — ห้าม crash
  const taskStages = task.stages || {};
  stages.forEach((s, i) => {
    const stage = taskStages[s] || {};
    const stageNum = i + 1;
    let status = '⏳ pending';
    if (stage.completed_at) status = '✅ completed';
    else if (stage.started_at) status = '🔄 in progress';
    console.log(`   [${stageNum}] ${s.padEnd(15)} ${status}`);
    if (stage.started_at) console.log(`        started: ${stage.started_at}`);
    if (stage.completed_at) console.log(`        completed: ${stage.completed_at}`);
    if (stage.result) console.log(`        result: ${stage.result}`);
    if (stage.plan) console.log(`        plan: ${stage.plan}`);
    if (stage.commits && stage.commits.length) console.log(`        commits: ${stage.commits.length}`);
    if (stage.files_changed && stage.files_changed.length) console.log(`        files: ${stage.files_changed.length}`);
  });
  console.log('');
  if ((task.blockers || []).length > 0) {
    console.log('🚧 Blockers:');
    task.blockers.forEach(b => console.log(`   - ${b}`));
    console.log('');
  }
  if ((task.decisions || []).length > 0) {
    console.log('📝 Decisions:');
    // 🆕 (T063-QA fix): decisions เป็นได้ทั้ง string และ object — แสดง title/action แทน [object Object]
    task.decisions.forEach(d => console.log(`   - ${typeof d === 'string' ? d : (d.title || d.action || JSON.stringify(d))}`));
    console.log('');
  }
  console.log(`Log file: ${task.log_file || '—'}`);
}

function cmdApproveMerge(prNumber) {
  const state = loadState();
  const pr = state.github.open_prs.find(p => p.number === parseInt(prNumber));
  if (!pr) {
    console.error(`ERROR: ไม่พบ PR #${prNumber}`);
    process.exit(1);
  }
  pr.status = 'approved_by_owner';
  pr.approved_at = new Date().toISOString();
  saveState(state);
  console.log(`✅ PR #${prNumber} marked as approved by owner`);
  console.log(`   URL: ${pr.url}`);
  console.log('');
  console.log('💡 Owner กด merge บน GitHub เท่านั้น (AI ห้าม merge เอง — กฎเหล็กข้อ 4)');
  console.log('   หลัง merge: Release Manager deploy ตามขั้น 13 (ต้องมี rollback plan ก่อนทุกครั้ง)');
}

function cmdCancel(taskId) {
  const state = loadState();
  const task = loadTask(taskId);
  if (!task) {
    console.error(`ERROR: ไม่พบ task ${taskId}`);
    process.exit(1);
  }
  task.status = 'cancelled';
  task.cancelled_at = new Date().toISOString();
  saveTask(task);
  // remove from active
  state.tasks.active = state.tasks.active.filter(t => t !== taskId);
  saveState(state);
  console.log(`✅ Cancelled task ${taskId}`);
  console.log(`   Branch ${task.branch} ยังอยู่ — ลบเองด้วย: git push origin --delete ${task.branch}`);
}

function cmdListBranches() {
  const branches = git('branch -r --list "origin/ai-team/*" origin/team-*');
  console.log('='.repeat(70));
  console.log('🌿 Branches in Miusic repo');
  console.log('='.repeat(70));
  if (branches) {
    console.log(branches);
  } else {
    console.log('ไม่พบ AI team branches');
  }
}

// ============ Main ============

const command = process.argv[2];
const arg = process.argv[3];

switch (command) {
  case 'status':
    cmdStatus();
    break;
  case 'new':
    cmdNew(arg);
    break;
  case 'resume':
    cmdResume();
    break;
  case 'show':
    cmdShow(arg);
    break;
  case 'approve-merge':
    cmdApproveMerge(arg);
    break;
  case 'cancel':
    cmdCancel(arg);
    break;
  case 'list-branches':
    cmdListBranches();
    break;
  case 'help':
  case '--help':
  case '-h':
  default:
    console.log('AI Team Manager — Commands:');
    console.log('  status                    แสดงสถานะทุก task');
    console.log('  new "<description>"       สร้าง task ใหม่');
    console.log('  resume                    ทำงานต่อจากที่ค้างไว้');
    console.log('  show <task-id>            แสดงรายละเอียด task');
    console.log('  approve-merge <PR#>       บันทึกว่า owner อนุมัติ merge PR');
    console.log('  cancel <task-id>          ยกเลิก task');
    console.log('  list-branches             แสดง branch ทั้งหมด');
    break;
}
