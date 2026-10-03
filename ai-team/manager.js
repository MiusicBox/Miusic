#!/usr/bin/env node
// /home/z/my-project/ai-team/manager.js
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
//   approve-merge <PR#>       - บันทึกว่า user อนุมัติ merge PR
//   cancel <task-id>          - ยกเลิก task
//   list-branches             - แสดง branch ทั้งหมดใน repo
// ============================================================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const AI_TEAM_DIR = '/home/z/my-project/ai-team';
const STATE_FILE = path.join(AI_TEAM_DIR, 'state.json');
const TASKS_DIR = path.join(AI_TEAM_DIR, 'tasks');
const LOGS_DIR = path.join(AI_TEAM_DIR, 'logs');
const TEAM_FILE = path.join(AI_TEAM_DIR, 'team.json');
const MIUSIC_DIR = '/home/z/my-project/Miusic';

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
    const m = t.match(/^T(\d+)$/);
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
    stages: {
      intake: { started_at: now, completed_at: null, result: null },
      analysis: { started_at: null, completed_at: null, plan: null, files_to_change: [] },
      implementation: { started_at: null, completed_at: null, commits: [], files_changed: [] },
      testing: { started_at: null, completed_at: null, regression: null, integration: null, syntax: null },
      security: { started_at: null, completed_at: null, audit_result: null, iron_rules_check: null },
      review: { started_at: null, completed_at: null, review_result: null, impact_analysis: null },
      pr: { started_at: null, pr_number: null, pr_url: null, merged_at: null }
    },
    blockers: [],
    decisions: [],
    log_file: path.join(LOGS_DIR, `${taskId}-${slug}.log`)
  };
  fs.writeFileSync(filepath, JSON.stringify(task, null, 2));
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
        console.log(`        stage: ${task.status} (stage ${task.current_stage}/8)`);
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
        if (task.stages.pr.pr_url) console.log(`        PR: ${task.stages.pr.pr_url}`);
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
  console.log('💡 AI Manager จะเริ่มทำงานที่ stage 1 (intake) → stage 2 (analysis)');
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
      console.log(`   ${t} — ${task.title} (stage ${task.current_stage}/8: ${task.status})`);
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
  console.log(`Status: ${task.status} (stage ${task.current_stage}/8)`);
  console.log(`Created: ${task.created_at}`);
  console.log(`Updated: ${task.updated_at}`);
  console.log('');
  console.log('Stages:');
  const stages = ['intake', 'analysis', 'implementation', 'testing', 'security', 'review', 'pr', 'merged'];
  stages.forEach((s, i) => {
    const stage = task.stages[s] || {};
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
  if (task.blockers.length > 0) {
    console.log('🚧 Blockers:');
    task.blockers.forEach(b => console.log(`   - ${b}`));
    console.log('');
  }
  if (task.decisions.length > 0) {
    console.log('📝 Decisions:');
    task.decisions.forEach(d => console.log(`   - ${d}`));
    console.log('');
  }
  console.log(`Log file: ${task.log_file}`);
}

function cmdApproveMerge(prNumber) {
  const state = loadState();
  const pr = state.github.open_prs.find(p => p.number === parseInt(prNumber));
  if (!pr) {
    console.error(`ERROR: ไม่พบ PR #${prNumber}`);
    process.exit(1);
  }
  pr.status = 'approved_by_user';
  pr.approved_at = new Date().toISOString();
  saveState(state);
  console.log(`✅ PR #${prNumber} marked as approved by user`);
  console.log(`   URL: ${pr.url}`);
  console.log('');
  console.log('💡 AI Manager จะ merge PR และ deploy ขึ้น production (หลังจากนั้น)');
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
    console.log('  approve-merge <PR#>       บันทึกว่า user อนุมัติ merge PR');
    console.log('  cancel <task-id>          ยกเลิก task');
    console.log('  list-branches             แสดง branch ทั้งหมด');
    break;
}
