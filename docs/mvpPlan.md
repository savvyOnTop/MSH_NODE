# CathAID MVP — Phase Plan (Backend + Frontend)

As of 2026-10-14. **MVP = everything in [businessLogic.md](businessLogic.md), including its gaps, except Amion integration and cross-health-system (cross-tenant) features.** Engineering detail per phase lives in [backendMLD.md](backendMLD.md); backend milestone numbers (M#) match [implementationPlan.md](implementationPlan.md).

**Teams and repos.** Backend: `cathaid-api` (this repo). Admin web: React. Mobile (clinicians + EMS crews): React Native.

**How we work across repos.**
- Backend publishes the OpenAPI contract (`/docs`) at the **start** of each phase. Frontend builds against a mock server generated from it, then switches to the real API mid-phase.
- Each phase ends with a demo on the shared staging stack and its exit test green: lint, tests, e2e.
- Phase gate: no phase starts until the previous phase's exit test passes and the team signs off.

---

## Phase 0 — Foundation ✅ done (M0–M2)
Express/Prisma skeleton, Postgres RLS tenant isolation, audit log, multi-tenant SSO, roles/permissions. Nothing for frontend to consume yet beyond login.

## Phase 1 — Organisation & Admin Shell (M3)
| | Scope |
|---|---|
| **Backend** | Facility geo + scheduling mode, diagnosis types, system-role seeds, permission catalog additions; departments (ED / Transfer Center flags), department roles + heads, groups, join requests, invitations, workspace preferences, hierarchy guards |
| **Admin web** | App shell, SSO login, role-aware navigation; tenant admin: hospitals, allowed diagnoses, hospital-admin invites; hospital admin: departments, roles, groups, join-request approvals, users, permission sets, deactivation |
| **Mobile** | App shell, SSO login, push-token registration, workspace switcher (hospital + workflow), profile, request to join a group |
| **Exit** | Tenant → hospital → department → group → invited user logs in on mobile and joins a group; join-request rule matrix passes |

## Phase 2 — Workflows (M4)
| | Scope |
|---|---|
| **Backend** | Frozen WorkflowDoc contract (incl. extensions C1–C12), validator, platform/tenant/hospital templates, clone/share/editors, **adoption as private copy**, versions + publish, auto Case Manager role, AI draft from text/PDF/DOCX + revise-with-feedback, clinical field linking |
| **Admin web** | Workflow builder (stages, stage roles, fields, transitions, escalation + condition rules, notifications, permissions), AI generate/revise/apply, validation errors view, publish, adopt to hospital, assign workflow roles to staff |
| **Mobile** | Workspace switcher lists adopted workflows and user's roles |
| **Exit** | MSH STEMI and Trauma sample authored as data, validated, published, adopted by two hospitals; one hospital's edit does not affect the other |

## Phase 3 — Cases Core (M5)
| | Scope |
|---|---|
| **Backend** | Case number, origin/destination, patient fields, statuses + frozen terminal cases, raise preconditions (incl. ED department raise), executor (advance/accept rules, required fields), field-level edit rights, timeline, case lists + counters + needs-action, idempotency, ECG + document uploads, priority, reopen, manual close/cancel |
| **Admin web** | Facility / tenant / all-cases lists with filters; case detail (read + case-manager edit); case-monitor read-only view |
| **Mobile** | Raise Alert form (raised-as, workflow, destination, patient, first-stage data); My Cases with needs-action badge; case screen: Current Stage (fields, Save Details, decision buttons), Patient Details, Timeline |
| **Exit** | STEMI raise → accept → treatment → discharge on mobile; reject path; double-accept gives one success + one 409; frozen case refuses edits |

## Phase 4 — Team, Scheduling, Notifications, Escalations (M6)
| | Scope |
|---|---|
| **Backend** | Case team + pick reasons, team builder (swap → roster → assignees − time off → coverage gap), case managers (auto-add, backfill, clean-up), add/remove member; CathAID roster, swaps, time off (recurrence), at-risk shifts; notification catalogue + inbox + push + retries/SMS/email/preferences; SLA timers; once-per-case escalations incl. code blue |
| **Admin web** | Roster editor + publish, swap approvals, time-off approvals, coverage-gap / at-risk alerts, on-call board, notification inbox |
| **Mobile** | Alerts inbox, alarm sounds + full-screen critical alert, Team tab, add member (case managers), My Schedule, swap + time-off requests, notification preferences |
| **Exit** | Stage entry pages the correct rostered user; time-off removes them; empty role raises a coverage gap; SLA breach and data escalation fire once |

## Phase 5 — Epic, Chat, AI (M7 + M8)
| | Scope |
|---|---|
| **Backend** | Epic sandbox connector: MRN → identity + encounter, first-stage fill-only-empty prefill (vitals, meds, conditions, MAP), AI chart review; case chat at raise, add by search/group, immutable messages, read cursors, chat push, AI catch-up, realtime fan-out; DMs, attachments, mentions, read receipts, lock on close |
| **Admin web** | EHR connection setup per hospital; chart review on case detail |
| **Mobile** | MRN lookup prefill on raise, Chart Review tab, Chat tab (realtime, add people/group, attachments, mentions), private catch-up summary |
| **Exit** | Raise with sandbox MRN prefills fields; Epic down still allows manual raise; two-device realtime chat; late joiner gets private summary |

## Phase 6 — Transfers & EMS (M9 + M10)
| | Scope |
|---|---|
| **Backend** | Transfer requests (ack/decline, raise-from-transfer, linked cases, source → Transferred); EMS providers (tenant-owned), crew, ambulances; 911 pre-alert flow; inter-facility transport requests + trips; GPS pings during travel, routing ETA, 2 km / 150 m geofences; EMS lists and visibility; fleet location, Transfer Center map, nearest-hospital picker |
| **Admin web** | EMS provider link + finalise; EMS admin: crew, ambulances, transport request queue (accept/assign/decline); Transfer Center map |
| **Mobile (clinician)** | Raise transfer, incoming transfer alerts, ack/decline, "open linked case", request ambulance, EMS Alerts + EMS Cases lists, live ambulance map on case |
| **Mobile (crew)** | Raise 911 alert (hospital picker), active trip screen, step advance, background GPS, arrived |
| **Exit** | 911 alert → ack → approaching → auto-arrive → case raised; A→B transfer with ambulance trip end to end; source case Transferred and linked |

## Phase 7 — Calls & Video (M11)
| | Scope |
|---|---|
| **Backend** | Call/video provider adapter (vendor under BAA chosen at phase start); recorded call to raiser + transcript + AI summary; group video sessions in case chat; 1:1 video, recording, VoIP push |
| **Admin web** | Call button + Calls tab; group video in chat |
| **Mobile** | Group video (ringing incl. app closed via CallKit/VoIP push), join/decline/missed, call summaries in Patient Details |
| **Exit** | Call recorded and summarised; group call rings all members; missed state recorded |

## Phase 8 — Metrics, QA/QI, Hardening, Pilot (M13 + M14)
| | Scope |
|---|---|
| **Backend** | Metric anchors from workflow data, door-to-balloon and interval metrics, SLA breach reports, QA/QI findings, weekly report job, live dashboard feed; AI voice-call fallback for missed critical alarms; security hardening (rate limits, headers), load test, backups, runbook; MSH seed data |
| **Admin web** | Dashboards, QA/QI reports, exports, audit viewer |
| **Mobile** | Offline queue + replay, crash/perf monitoring, store builds |
| **Exit (MVP launch)** | Mount Sinai pilot: full STEMI run across two hospitals with an ambulance leg, measured D2B on dashboard, pen test and HIPAA risk review passed |

---

## Out of MVP
- **Amion**: hourly sync, AI staff/role matching, review queues, Amion-aware raise rule.
- **Cross-health-system**: transfers between tenants, independent EMS shared across tenants, shared patient master, cross-tenant super-admin reads.

## Long-lead items to start now
Epic sandbox app registration · Firebase/APNs credentials · BAAs (AI, voice/video, SMS) · routing/maps vendor choice · call/video vendor choice · app store accounts.
